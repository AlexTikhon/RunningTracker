import type { WeeklyInsightOutput } from '@running-tracker/contracts';

import { hasExtremeValues, type WeeklyAggregate } from './weekly-aggregate.js';

// Safety check (ADR-0076). A weekly insight is not medical advice, so an answer is discarded when any of its text
// (summary, observations, suggestion, data gaps) diagnoses, names a medical condition, mentions medication or
// supplements, or gives a medical, treatment or dietary instruction. When the week has an extreme soreness or sleep
// value, the suggestion must also recommend only rest and recovery, or a healthcare professional in generic terms.
//
// This is a conservative lexicon, not an understanding of the text: it refuses some harmless wording (it would rather
// discard a fine answer than store a harmful one) and it cannot catch harmful advice phrased in words it does not
// list. The evaluation (Stop 2) measures how often real models trip it. Each rule has an id; a violation reports the
// rule id and the field, never the text.

export type SafetyField = 'dataGaps' | 'observations' | 'suggestion' | 'summary';
export type SafetyKind = 'diagnosis' | 'extreme_values_suggestion' | 'medical_instruction' | 'medication';

export interface SafetyViolation {
  field: SafetyField;
  kind: SafetyKind;
  /** The id of the rule that matched. */
  rule: string;
}

interface Rule {
  id: string;
  kind: Exclude<SafetyKind, 'extreme_values_suggestion'>;
  pattern: RegExp;
}

const rules: readonly Rule[] = [
  // Diagnoses and named conditions.
  { id: 'diagnose', kind: 'diagnosis', pattern: /\bdiagnos\w*/u },
  { id: 'condition-generic', kind: 'diagnosis', pattern: /\b(?:disorders?|syndromes?|diseases?|illness(?:es)?|infections?|deficienc(?:y|ies)|deficient|symptoms?|clinical(?:ly)?|patholog\w*|chronic|medical conditions?)\b/u },
  { id: 'condition-sleep', kind: 'diagnosis', pattern: /\b(?:insomnia|apnoea|apnea|narcolepsy|sleep deprivation)\b/u },
  { id: 'condition-mental', kind: 'diagnosis', pattern: /\b(?:depression|depressive|depressed|anxiety disorder|bipolar|adhd|burnout)\b/u },
  { id: 'condition-musculoskeletal', kind: 'diagnosis', pattern: /\b(?:tendin(?:itis|opathy)|tendonitis|fractures?|sprain(?:s|ed)?|strained|torn|inflamm\w*|inflamed|concussion|shin splints|plantar fasciitis|arthritis|rhabdo\w*|overtrain\w*)\b/u },
  { id: 'condition-injury', kind: 'diagnosis', pattern: /\b(?:injured|(?:an|your|have an?|has an?|had an?|signs? of an?)\s+injur(?:y|ies))\b/u },
  { id: 'condition-metabolic', kind: 'diagnosis', pattern: /\b(?:an(?:a)?emi\w*|hypertension|hypotension|diabet\w*|obes(?:e|ity)|overweight|underweight|anorexi\w*|bulimi\w*|eating disorder|dehydrat\w*)\b/u },
  // Medication and supplements.
  { id: 'medication-generic', kind: 'medication', pattern: /\b(?:medications?|medicines?|medicat\w*|drugs?|pills?|tablets?|capsules?|doses?|dosage|prescri\w*|painkillers?|pain relievers?|analgesics?|sedatives?|opioids?|steroids?|antibiotics?|antidepressants?|supplements?|supplementation|vitamins?)\b/u },
  { id: 'medication-named', kind: 'medication', pattern: /\b(?:ibuprofen|paracetamol|acetaminophen|aspirin|naproxen|nsaids?|melatonin|cortisone|magnesium|creatine|caffeine pills?|cbd)\b/u },
  { id: 'medication-amount', kind: 'medication', pattern: /\b\d+(?:\.\d+)?\s?(?:mg|mcg|µg|ml)\b/u },
  // Medical, treatment and dietary instructions.
  { id: 'treatment', kind: 'medical_instruction', pattern: /\b(?:treat|treats|treating|treatments?|therap(?:y|ies|ist|ists)|physiotherap\w*|physical therap\w*|rehab\w*|cure|cures|heal|heals|healing)\b/u },
  { id: 'cold-compression', kind: 'medical_instruction', pattern: /\b(?:ice (?:it|the|your|bath|baths)|icing|cold plunge|compression|elevate (?:it|the|your))\b/u },
  { id: 'diet', kind: 'medical_instruction', pattern: /\b(?:diets?|dieting|calories|calorie|fasting|eat less|lose weight|gain weight|cut (?:back )?(?:on )?(?:carbs|calories|sugar|food))\b/u },
  { id: 'escalation', kind: 'medical_instruction', pattern: /\b(?:emergency|hospital|urgent care|blood pressure|blood tests?|call 911|call 112)\b/u },
];

// Extreme weeks: the suggestion must recommend rest/recovery or a professional, and nothing that adds training.
const restOrProfessional =
  /\b(?:rest|resting|rested|recover|recovery|recuperate|take it easy|sleep|relax|relaxation|day off|days off|healthcare professional|health care professional|healthcare provider|medical professional|a professional|doctor|physician|gp)\b/u;
const adds =
  /\b(?:increase|increasing|harder|push(?:ing)?|intervals?|tempo|speed ?work|long(?:er)? runs?|mileage|intensity|intense|challenge|personal best|faster|extra|walks?|walking|jog|jogging|stretch\w*|yoga|swim\w*|cycling|workouts?|exercises?|train more|more training)\b|\b(?:go for|do|try|add|schedule|plan)\s+(?:a |an |another |one |two )?(?:short |easy |light |gentle )?(?:run|session|jog|ride)\b/u;

/** Lower case, compatibility-normalised, typographic apostrophes and dashes made plain, whitespace collapsed. */
export function normalizeForSafety(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’ʼ]/gu, "'")
    .replace(/[‐-―]/gu, '-')
    .replace(/\s+/gu, ' ');
}

function textsOf(output: WeeklyInsightOutput): { field: SafetyField; text: string }[] {
  return [
    { field: 'summary', text: output.summary },
    ...output.observations.map((observation) => ({ field: 'observations' as const, text: observation.text })),
    { field: 'suggestion', text: output.suggestion },
    ...output.dataGaps.map((gap) => ({ field: 'dataGaps' as const, text: gap })),
  ];
}

/** Every safety violation of a schema-valid answer; empty when it is safe. */
export function checkSafety(output: WeeklyInsightOutput, aggregate: Pick<WeeklyAggregate, 'flags'>): SafetyViolation[] {
  const violations: SafetyViolation[] = [];
  for (const { field, text } of textsOf(output)) {
    const normalized = normalizeForSafety(text);
    for (const rule of rules) {
      if (rule.pattern.test(normalized)) violations.push({ field, kind: rule.kind, rule: rule.id });
    }
  }
  if (hasExtremeValues(aggregate)) {
    const suggestion = normalizeForSafety(output.suggestion);
    if (!restOrProfessional.test(suggestion)) {
      violations.push({ field: 'suggestion', kind: 'extreme_values_suggestion', rule: 'extreme-requires-rest-or-professional' });
    }
    if (adds.test(suggestion)) {
      violations.push({ field: 'suggestion', kind: 'extreme_values_suggestion', rule: 'extreme-forbids-training' });
    }
  }
  return violations;
}
