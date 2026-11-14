import { MEAL_NUTRITION_FIELDS } from '@running-tracker/contracts';
import type { FormEvent } from 'react';

import {
  describeDraftClarification,
  describeDraftError,
  describeDraftUnsupported,
  describeNutritionResult,
  draftTextProblem,
  MEAL_DRAFT_DISABLED_NOTICE,
  MEAL_DRAFT_DISCLOSURE,
  MEAL_DRAFT_INPUT_MAX,
  type MealDraftProposal,
} from './meal-draft.js';
import type { MealDraftSnapshot } from './meal-draft-controller.js';
import { formatNutritionValue, mealTypeLabels, nutritionInputLabel } from './meal-log.js';

// "Draft from text" (ADR-0092): the text goes to the server only on an explicit click; what comes back is shown with its
// evidence and changes nothing until the person presses "Apply to form", which only fills the editable form below. Saving
// stays the form's own, separate action. The manual form works whatever this panel says.

export interface MealDraftPanelHandlers {
  apply: () => void;
  cancel: () => void;
  confirmReplace: () => void;
  discard: () => void;
  keepForm: () => void;
  propose: () => void;
  textChange: (text: string) => void;
}

export interface MealDraftPanelProps {
  /** Why a proposal cannot be applied right now (an edit, a save in flight, an earlier save that went through), or null. */
  applyBlocked: string | null;
  /** The form holds unsaved details and the person pressed Apply: replacing them needs a second, explicit choice. */
  confirmingReplace: boolean;
  handlers: MealDraftPanelHandlers;
  /** Why no proposal can be asked for right now (an edit in progress), or null. */
  proposeBlocked: string | null;
  snapshot: MealDraftSnapshot;
  text: string;
}

function ProposalReview({ applyBlocked, confirmingReplace, handlers, proposal }: Pick<MealDraftPanelProps, 'applyBlocked' | 'confirmingReplace' | 'handlers'> & { proposal: MealDraftProposal }) {
  return (
    <section aria-labelledby="meal-draft-proposal-title" className="meal-draft__proposal">
      <h3 id="meal-draft-proposal-title">Proposed draft (not saved)</h3>
      <dl aria-label="Proposed values and their evidence" className="meal-draft__fields">
        <div>
          <dt>Title</dt>
          <dd>
            <strong>{proposal.title}</strong>
            <span className="meal-draft__evidence">Copied from your text.</span>
          </dd>
        </div>
        <div>
          <dt>Meal type</dt>
          <dd>
            {proposal.mealType.status === 'proposed' ? (
              <>
                <strong>{mealTypeLabels[proposal.mealType.value]}</strong>
                <span className="meal-draft__evidence">From your text: “{proposal.mealType.excerpt}”</span>
              </>
            ) : (
              <span className="meal-draft__evidence">Not named in your text; the form keeps its meal type.</span>
            )}
          </dd>
        </div>
        {MEAL_NUTRITION_FIELDS.map((field) => {
          const result = proposal.nutrition[field];
          return (
            <div className={result.status === 'proposed' ? undefined : 'today-rows__missing'} data-draft-field={field} data-draft-status={result.status} key={field}>
              <dt>{nutritionInputLabel(field)}</dt>
              <dd>
                {result.status === 'proposed' && <strong>{formatNutritionValue(field, result.value)}</strong>}
                <span className="meal-draft__evidence">{describeNutritionResult(result)}</span>
              </dd>
            </div>
          );
        })}
      </dl>
      {applyBlocked !== null && <p className="activity-form__warning">{applyBlocked}</p>}
      {confirmingReplace ? (
        <div className="activity-form__warning" role="alert">
          <p>The form already has details you have not saved. Replace them with this draft?</p>
          <div className="activity-form__actions">
            <button className="primary-action" disabled={applyBlocked !== null} onClick={handlers.confirmReplace} type="button">Replace form details</button>
            <button onClick={handlers.keepForm} type="button">Keep my details</button>
          </div>
        </div>
      ) : (
        <div className="activity-form__actions">
          <button className="primary-action" disabled={applyBlocked !== null} onClick={handlers.apply} type="button">Apply to form</button>
          <button onClick={handlers.discard} type="button">Discard</button>
        </div>
      )}
      <p className="meal-draft__hint">Applying only fills the form below. Check and edit every value, then press “Add entry” to save it.</p>
    </section>
  );
}

function Outcome(props: MealDraftPanelProps) {
  const { snapshot } = props;
  switch (snapshot.status) {
    case 'idle':
    case 'unavailable':
      return null;
    case 'proposing':
      return <p role="status">Drafting from your text… A local model can take up to a minute.</p>;
    case 'proposal':
      return <ProposalReview applyBlocked={props.applyBlocked} confirmingReplace={props.confirmingReplace} handlers={props.handlers} proposal={snapshot.proposal} />;
    case 'clarify':
      return <p role="status">{describeDraftClarification(snapshot.reason)}</p>;
    case 'unsupported':
      return <p role="status">{describeDraftUnsupported(snapshot.reason)}</p>;
    case 'error':
      return <p className="activity-form__failure" role="alert">{describeDraftError(snapshot.kind, snapshot.retryAfterMs)}</p>;
  }
}

/** Everything the panel shows, from its props. Pure, so every state is testable without a DOM. */
export function MealDraftPanel(props: MealDraftPanelProps) {
  const { handlers, proposeBlocked, snapshot, text } = props;
  const problem = text === '' ? null : draftTextProblem(text);
  const proposing = snapshot.status === 'proposing';
  const empty = text.trim() === '';
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!proposing && !empty && problem === null && proposeBlocked === null) handlers.propose();
  };

  return (
    <section aria-labelledby="meal-draft-title" className="search-filters meal-draft">
      <h2 id="meal-draft-title">Draft from text (optional)</h2>
      {snapshot.status === 'unavailable' ? (
        <p className="meal-draft__disabled" role="status">{MEAL_DRAFT_DISABLED_NOTICE}</p>
      ) : (
        <form aria-label="Describe one meal" onSubmit={submit}>
          <label>
            Describe one meal in your own words (English or Russian)
            <textarea
              aria-describedby="meal-draft-disclosure"
              disabled={proposing}
              onChange={(event) => handlers.textChange(event.target.value)}
              placeholder="Dinner: chicken and rice, total 650 kcal, protein 40 g"
              rows={3}
              value={text}
            />
          </label>
          <p className="meal-draft__disclosure" id="meal-draft-disclosure">{MEAL_DRAFT_DISCLOSURE}</p>
          <div className="activity-form__actions">
            <button disabled={proposing || empty || problem !== null || proposeBlocked !== null} type="submit">
              {proposing ? 'Drafting…' : 'Propose draft'}
            </button>
            {proposing && <button onClick={handlers.cancel} type="button">Cancel</button>}
            <span className="search-interpreter__count">
              {[...text].length}/{MEAL_DRAFT_INPUT_MAX}
            </span>
          </div>
          {problem !== null && <p className="search-filters__errors" role="alert">{problem}</p>}
          {proposeBlocked !== null && <p className="meal-draft__hint">{proposeBlocked}</p>}
        </form>
      )}
      <div aria-live="polite" className="meal-draft__outcome" data-meal-draft-state={snapshot.status}>
        <Outcome {...props} />
      </div>
    </section>
  );
}
