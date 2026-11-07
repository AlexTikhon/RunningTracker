import type { WeeklyInsightModelOutput } from '@running-tracker/contracts';

import { hasExtremeValues, type WeeklyAggregate, type WeeklyFlag } from './weekly-aggregate.js';

// Safety (ADR-0076, policy 2). Two different mechanisms, with different strength:
//
// 1. BOUNDED, in code: in a week with extreme soreness or sleep values, the suggestion is not the model's. Code selects
//    it from the small approved, non-medical set below, by flag. The model is told to write none (and anything it
//    writes is dropped, never shown). The safety of that sentence therefore does not depend on how the model, or a
//    word list, reads "rest" or "professional".
//
// 2. HEURISTIC, over the model's prose (summary, observation text, its suggestion in an ordinary week): a screen that
//    refuses the answer when any text matches a rule family. It is measured on a labelled set (safety-fixtures.ts,
//    insight-safety-evaluation.spec.ts) and is NOT a guarantee: it misses harmful advice phrased outside its patterns
//    and refuses some harmless wording. The families are structural (a negation scoped over a help-seeking verb; a
//    dismissal verb scoped over a symptom word), so a new phrasing of the same idea is often caught without a new
//    phrase in a list; the topic lexicon (conditions, medication, treatment, diet) is a list and has a list's limits.
//
// A violation reports the rule id and the field, never the text.

export type SafetyField = 'observations' | 'suggestion' | 'summary';
export type SafetyKind = 'avoid_help' | 'diagnosis' | 'dismiss_symptom' | 'escalation' | 'medical_instruction' | 'medication';

export interface SafetyViolation {
  field: SafetyField;
  kind: SafetyKind;
  /** The id of the rule that matched. */
  rule: string;
}

interface Rule {
  /** Only in weeks with extreme values. */
  extremeOnly?: boolean;
  id: string;
  kind: SafetyKind;
  test: (normalized: string) => boolean;
}

const pattern = (expression: RegExp) => (normalized: string) => expression.test(normalized);

// Word classes of the structural rules.
const symptom =
  "(?:pain|pains|painful|ache|aches|aching|achy|sore|soreness|discomfort|hurt|hurts|hurting|dizzy|dizziness|faint|fainting|fainted|numb|numbness|swelling|swollen|tingling|chest|breathless|breathlessness|short of breath|symptom|symptoms|injury|injuries|exhaustion)";
const dismissal =
  "(?:ignore|ignores|ignoring|ignored|disregard|disregarding|push through|pushing through|power through|work through|train through|run through|tough it out|toughing it out|brush off|brushing off|shrug off|shrugging off|play down|downplay|downplaying)";
const downplay =
  "(?:nothing to worry about|no need to worry|don't worry about|do not worry about|not worth worrying|will pass on its own|pass by itself|goes away on its own|go away on its own|harmless|normal and fine)";
const negation =
  "(?:don't|do not|dont|never|avoid|avoiding|without|skip|skipping|no need to|there's no need to|there is no need to|needn't|need not|not necessary to|refrain from|stop|not)";
const helpVerb =
  "(?:tell|telling|see|seeing|contact|contacting|consult|consulting|talk to|talking to|talk with|speak to|speak with|ask|asking|call|calling|seek|seeking|visit|visiting|inform|informing|mention|mentioning|bother|bothering|report|reporting|check with)";
const helpTarget =
  "(?:a professional|professional|professionals|doctor|doctors|physician|gp|nurse|physio|coach|anyone|someone|somebody|medical|healthcare|health care|help|advice|care)";
const continueTraining = "(?:keep|continue|carry on|keep up)(?:\\s+\\w+){0,2}\\s+(?:training|running|pushing|mileage|intensity|workouts?|going hard)";

// A negation within three words before a help verb, optionally followed by a help target within four words, or the
// help verb directly followed by a target. "Don't hesitate to ..." is the one double negative removed first.
const avoidHelp = new RegExp(
  `\\b${negation}\\b(?:\\s+[\\w'-]+){0,3}?\\s+${helpVerb}\\b(?:(?:\\s+[\\w'-]+){0,4}?\\s+${helpTarget}\\b|(?=.*\\b${symptom}\\b))`,
  'u',
);
const dismissSymptom = new RegExp(`\\b${dismissal}\\b(?:\\s+[\\w'-]+){0,6}?\\s+${symptom}\\b`, 'u');
const downplaySymptom = new RegExp(`\\b${downplay}\\b`, 'u');
const mentionsSymptom = new RegExp(`\\b${symptom}\\b`, 'u');
const conceal = /\b(?:keep (?:it|this|that|the [\w-]+|your [\w-]+) to yourself|hide (?:it|this|the|your)|keep (?:it|this) quiet)\b/u;
const trainDespite = new RegExp(`\\b${continueTraining}\\b`, 'u');

const rules: readonly Rule[] = [
  // Topic lexicon: diagnoses and named conditions.
  { id: 'diagnose', kind: 'diagnosis', test: pattern(/\bdiagnos\w*/u) },
  { id: 'condition-generic', kind: 'diagnosis', test: pattern(/\b(?:disorders?|syndromes?|diseases?|illness(?:es)?|infections?|deficienc(?:y|ies)|deficient|clinical(?:ly)?|patholog\w*|chronic|medical conditions?)\b/u) },
  { id: 'condition-sleep', kind: 'diagnosis', test: pattern(/\b(?:insomnia|apnoea|apnea|narcolepsy|sleep deprivation)\b/u) },
  { id: 'condition-mental', kind: 'diagnosis', test: pattern(/\b(?:depression|depressive|depressed|anxiety disorder|bipolar|adhd|burnout)\b/u) },
  { id: 'condition-musculoskeletal', kind: 'diagnosis', test: pattern(/\b(?:tendin(?:itis|opathy)|tendonitis|fractures?|sprain(?:s|ed)?|strained|torn|inflamm\w*|inflamed|concussion|shin splints|plantar fasciitis|arthritis|rhabdo\w*|overtrain\w*)\b/u) },
  { id: 'condition-injury', kind: 'diagnosis', test: pattern(/\b(?:injured|(?:an|your|have an?|has an?|had an?|signs? of an?)\s+injur(?:y|ies))\b/u) },
  { id: 'condition-metabolic', kind: 'diagnosis', test: pattern(/\b(?:an(?:a)?emi\w*|hypertension|hypotension|diabet\w*|obes(?:e|ity)|overweight|underweight|anorexi\w*|bulimi\w*|eating disorder|dehydrat\w*)\b/u) },
  // Topic lexicon: medication and supplements.
  { id: 'medication-generic', kind: 'medication', test: pattern(/\b(?:medications?|medicines?|medicat\w*|drugs?|pills?|tablets?|capsules?|doses?|dosage|prescri\w*|painkillers?|pain relievers?|analgesics?|sedatives?|opioids?|steroids?|antibiotics?|antidepressants?|supplements?|supplementation|vitamins?)\b/u) },
  { id: 'medication-named', kind: 'medication', test: pattern(/\b(?:ibuprofen|paracetamol|acetaminophen|aspirin|naproxen|nsaids?|melatonin|cortisone|magnesium|creatine|caffeine pills?|cbd)\b/u) },
  // Topic lexicon: medical, treatment and dietary instructions.
  { id: 'treatment', kind: 'medical_instruction', test: pattern(/\b(?:treat|treats|treating|treatments?|therap(?:y|ies|ist|ists)|physiotherap\w*|physical therap\w*|rehab\w*|cure|cures|heal|heals|healing)\b/u) },
  { id: 'cold-compression', kind: 'medical_instruction', test: pattern(/\b(?:ice (?:it|the|your|bath|baths)|icing|cold plunge|compression|elevate (?:it|the|your))\b/u) },
  { id: 'diet', kind: 'medical_instruction', test: pattern(/\b(?:diets?|dieting|calories|calorie|fasting|fast for|eat less|lose weight|gain weight|cut (?:back )?(?:on )?(?:carbs|calories|sugar|food))\b/u) },
  { id: 'escalation-services', kind: 'medical_instruction', test: pattern(/\b(?:emergency|hospital|urgent care|blood pressure|blood tests?|call 911|call 112)\b/u) },
  // Structural: discouraging help, dismissing symptoms, concealing them.
  { id: 'avoid-help', kind: 'avoid_help', test: (text) => avoidHelp.test(text.replace(/\b(?:don't|do not|never) hesitate to\b/gu, 'feel free to')) },
  { id: 'conceal', kind: 'avoid_help', test: pattern(conceal) },
  { id: 'dismiss-symptom', kind: 'dismiss_symptom', test: pattern(dismissSymptom) },
  { id: 'downplay-symptom', kind: 'dismiss_symptom', test: (text) => downplaySymptom.test(text) && mentionsSymptom.test(text) },
  { id: 'train-despite-symptom', kind: 'dismiss_symptom', test: (text) => trainDespite.test(text) && mentionsSymptom.test(text) },
  // Extreme weeks: no prose may push training.
  {
    extremeOnly: true,
    id: 'extreme-forbids-training',
    kind: 'escalation',
    test: pattern(
      /\b(?:increase|increasing|harder|push(?:ing)?|intervals?|tempo|speed ?work|long(?:er)? runs?|mileage|intensity|intense|challenge|personal best|faster|train more|more training|keep training)\b|\b(?:go for|do|try|add|schedule|plan)\s+(?:a |an |another |one )?(?:short |easy |light |gentle )?(?:run|session|jog|ride|workout)\b/u,
    ),
  },
];

/** Lower case, compatibility-normalised, typographic apostrophes and dashes made plain, whitespace collapsed. */
export function normalizeForSafety(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’ʼ]/gu, "'")
    .replace(/[‐-―]/gu, '-')
    .replace(/\s+/gu, ' ');
}

/** The rule ids a text matches. Exported for the evaluation fixtures. */
export function screenText(text: string, extreme: boolean): { kind: SafetyKind; rule: string }[] {
  const normalized = normalizeForSafety(text);
  return rules
    .filter((rule) => (extreme || !rule.extremeOnly) && rule.test(normalized))
    .map((rule) => ({ kind: rule.kind, rule: rule.id }));
}

/**
 * Every safety violation in the prose that will be shown. In a week with extreme values the model's suggestion is never
 * shown (code selects one), so it is not screened.
 */
export function checkSafety(output: WeeklyInsightModelOutput, aggregate: Pick<WeeklyAggregate, 'flags'>): SafetyViolation[] {
  const extreme = hasExtremeValues(aggregate);
  const texts: { field: SafetyField; text: string }[] = [
    { field: 'summary', text: output.summary },
    ...output.observations.map((observation) => ({ field: 'observations' as const, text: observation.text })),
  ];
  if (!extreme && output.suggestion !== null) texts.push({ field: 'suggestion', text: output.suggestion });
  return texts.flatMap(({ field, text }) => screenText(text, extreme).map((match) => ({ field, ...match })));
}

/** The approved suggestions of extreme weeks. Code-written, non-medical, no instruction beyond rest and a generic referral. */
export const APPROVED_SUGGESTIONS = {
  rest_and_recovery: 'Consider keeping this week light and making rest and recovery the priority.',
  rest_and_sleep_routine: 'Consider protecting time for rest and a calm, regular wind-down before bed this week.',
  check_in_with_professional:
    'If something feels unusual or keeps bothering you, consider talking with a healthcare professional.',
} as const;
export type ApprovedSuggestionId = keyof typeof APPROVED_SUGGESTIONS;

/**
 * The suggestion code selects for a week with extreme values, or undefined for an ordinary week (the model writes it
 * then). Soreness takes precedence over sleep; very long or very short sleep share the sleep routine sentence; each is
 * followed by the generic referral sentence, which is a separate approved item.
 */
export function approvedSuggestionFor(aggregate: Pick<WeeklyAggregate, 'flags'>): { id: ApprovedSuggestionId; text: string } | undefined {
  if (!hasExtremeValues(aggregate)) return undefined;
  const flags = new Set<WeeklyFlag>(aggregate.flags);
  const first: ApprovedSuggestionId = flags.has('extreme_soreness') ? 'rest_and_recovery' : 'rest_and_sleep_routine';
  return { id: first, text: `${APPROVED_SUGGESTIONS[first]} ${APPROVED_SUGGESTIONS.check_in_with_professional}` };
}
