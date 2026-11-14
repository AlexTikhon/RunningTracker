import type { MealDraftProposalResponse } from '@running-tracker/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { applyProposalToDraft, draftTextProblem, hasUnsavedDetails, type MealDraftProposal } from './meal-draft.js';
import { emptyMealDraft, validateMealDraft } from './meal-log.js';
import { MealDraftPanel, type MealDraftPanelProps } from './MealDraftPanel.js';
import { idleMealSave, loadingMealList } from './meal-log-controller.js';
import { MealLogView } from './MealLogScreen.js';

const DAY = '2026-11-13';
const noop = () => undefined;
const proposal: MealDraftProposal = {
  localDate: DAY,
  mealType: { excerpt: 'Dinner', status: 'proposed', value: 'dinner' },
  nutrition: {
    carbohydrateG: { status: 'not_stated' },
    energyKcal: { excerpt: 'total 650 kcal', status: 'proposed', value: 650 },
    fatG: { status: 'proposed', excerpt: 'fat 0 g', value: 0 },
    proteinG: { reason: 'per_portion', status: 'withheld' },
  },
  outcome: 'draft',
  timeZone: 'Europe/Warsaw',
  title: 'chicken and rice',
  version: 'meal-draft-1',
} satisfies MealDraftProposalResponse;
const scope = { localDate: DAY, text: 'Dinner: chicken and rice, total 650 kcal, fat 0 g, protein 20 g per serving' };

function props(patch: Partial<MealDraftPanelProps> = {}): MealDraftPanelProps {
  return {
    applyBlocked: null,
    confirmingReplace: false,
    handlers: { apply: noop, cancel: noop, confirmReplace: noop, discard: noop, keepForm: noop, propose: noop, textChange: noop },
    proposeBlocked: null,
    snapshot: { status: 'idle' },
    text: '',
    ...patch,
  };
}
const render = (patch: Partial<MealDraftPanelProps> = {}) => renderToStaticMarkup(<MealDraftPanel {...props(patch)} />);

describe('Draft from text panel (ADR-0092)', () => {
  it('discloses what is sent and that nothing is saved, and sends nothing while the text is empty', () => {
    const html = render();
    expect(html).toContain('Draft from text (optional)');
    expect(html).toContain('Only the text you type here is sent to the local AI model on this server');
    expect(html).toContain('nothing is estimated, looked up or calculated');
    expect(html).toContain('Nothing is saved until you press &quot;Add entry&quot;.');
    expect(html).toContain('<button disabled="" type="submit">Propose draft</button>');
  });

  it('shows the proposal with the evidence for every value, and what was withheld and why, before anything is applied', () => {
    const html = render({ snapshot: { proposal, scope, status: 'proposal' }, text: scope.text });
    expect(html).toContain('Proposed draft (not saved)');
    expect(html).toContain('<strong>chicken and rice</strong>');
    expect(html).toContain('From your text: “Dinner”');
    expect(html).toContain('<strong>650 kcal</strong>');
    expect(html).toContain('From your text: “total 650 kcal”');
    // A recorded zero is a value, shown as zero.
    expect(html).toContain('<strong>0 g</strong>');
    expect(html).toContain('Not filled in: your text gives it per 100 g, per serving or per piece');
    expect(html).toContain('Not in your text; it stays empty (unknown).');
    expect(html).toContain('>Apply to form</button>');
    expect(html).toContain('Applying only fills the form below.');
  });

  it('asks before replacing unsaved details, and blocks applying during an edit or after an earlier save went through', () => {
    const confirming = render({ confirmingReplace: true, snapshot: { proposal, scope, status: 'proposal' } });
    expect(confirming).toContain('The form already has details you have not saved. Replace them with this draft?');
    expect(confirming).toContain('>Replace form details</button>');
    expect(confirming).toContain('>Keep my details</button>');
    const blocked = render({ applyBlocked: 'Finish or cancel the edit first: a draft only fills a new entry.', snapshot: { proposal, scope, status: 'proposal' } });
    expect(blocked).toContain('<button class="primary-action" disabled="" type="button">Apply to form</button>');
    expect(blocked).toContain('Finish or cancel the edit first');
  });

  it('shows drafting with Cancel, the outcomes, failures and the off state', () => {
    expect(render({ snapshot: { scope, status: 'proposing' }, text: 'x' })).toContain('Drafting…');
    expect(render({ snapshot: { scope, status: 'proposing' }, text: 'x' })).toContain('>Cancel</button>');
    expect(render({ snapshot: { reason: 'multiple_meals', scope, status: 'clarify' } })).toContain('more than one meal');
    expect(render({ snapshot: { reason: 'estimate_requested', scope, status: 'unsupported' } })).toContain('nothing is estimated or looked up');
    expect(render({ snapshot: { kind: 'timeout', retryAfterMs: null, status: 'error' } })).toContain('took too long');
    const off = render({ snapshot: { status: 'unavailable' } });
    expect(off).toContain('Drafting from text is not turned on for this server. The form below works as always.');
    expect(off).not.toContain('<textarea');
  });

  it('refuses text the server would refuse, without cutting it', () => {
    expect(draftTextProblem('   ')).toContain('Describe one meal');
    expect(draftTextProblem('x'.repeat(501))).toContain('at most 500 characters');
    expect(draftTextProblem('Soup\u0007')).toContain('cannot be sent');
    expect(draftTextProblem('x'.repeat(500))).toBeNull();
  });
});

describe('applying a proposal (ADR-0092)', () => {
  it('replaces the title and every value (not proposed means empty), keeps the meal type unless named, and stays a valid draft', () => {
    const current = { ...emptyMealDraft, carbohydrateG: '99', mealType: 'snack' as const, title: 'Old' };
    const applied = applyProposalToDraft(proposal, current);
    expect(applied).toEqual({ carbohydrateG: '', energyKcal: '650', fatG: '0', mealType: 'dinner', proteinG: '', title: 'chicken and rice' });
    expect(applyProposalToDraft({ ...proposal, mealType: { status: 'not_stated' } }, current).mealType).toBe('snack');
    const validation = validateMealDraft(applied);
    expect(validation).toEqual({ details: { carbohydrateG: null, energyKcal: 650, fatG: 0, mealType: 'dinner', proteinG: null, title: 'chicken and rice' }, ok: true });
  });

  it('counts only typed or applied details as unsaved, never the meal type alone', () => {
    expect(hasUnsavedDetails(emptyMealDraft)).toBe(false);
    expect(hasUnsavedDetails({ ...emptyMealDraft, mealType: 'dinner' })).toBe(false);
    expect(hasUnsavedDetails({ ...emptyMealDraft, title: 'Soup' })).toBe(true);
    expect(hasUnsavedDetails({ ...emptyMealDraft, fatG: '0' })).toBe(true);
  });

  it('marks an applied, unsaved form and keeps the manual source line (a confirmed draft is a manual entry)', () => {
    const html = renderToStaticMarkup(
      <MealLogView
        busy={false}
        dateInput={DAY}
        deletion={null}
        draft={applyProposalToDraft(proposal, emptyMealDraft)}
        draftApplied
        draftPanel={props()}
        editing={null}
        errors={null}
        handlers={{ askDelete: noop, cancelDelete: noop, cancelEdit: noop, chooseDate: noop, confirmDelete: noop, edit: noop, goToToday: noop, loadMore: noop, retryList: noop, startNew: noop, submit: noop, update: noop }}
        list={{ ...loadingMealList(DAY), status: 'ready' }}
        notice={null}
        repeatsUncertain={false}
        save={idleMealSave}
        timeZone="Europe/Warsaw"
        today="2026-11-14"
      />,
    );
    expect(html.indexOf('Draft from text (optional)')).toBeLessThan(html.indexOf('Add an entry for'));
    expect(html).toContain('Filled in from your text and not saved yet.');
    expect(html).toContain('stored as manually entered, because you confirm each value yourself');
    expect(html).toContain('Source: <span class="review-badge">Manually entered</span>');
    expect(html).toContain('value="chicken and rice"');
  });
});
