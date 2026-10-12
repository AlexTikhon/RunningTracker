import type { FormEvent } from 'react';

import type { InterpretationSnapshot } from './run-search-interpretation-controller.js';
import {
  describeClarification,
  describeInterpretationError,
  describeUnsupported,
  INTERPRETATION_DISCLOSURE,
  INTERPRETATION_TEXT_MAX,
  interpretationTextProblem,
} from './run-search-interpretation.js';

export interface RunSearchInterpreterProps {
  onInterpret: () => void;
  onTextChange: (text: string) => void;
  snapshot: InterpretationSnapshot;
  text: string;
}

function Outcome({ snapshot }: { snapshot: InterpretationSnapshot }) {
  switch (snapshot.status) {
    case 'idle':
      return null;
    case 'interpreting':
      return <p role="status">Interpreting your text…</p>;
    case 'proposal':
      return (
        <p role="status">
          Filters filled in from your text. Review or change them, then press “Apply filters”. Nothing has been
          searched yet, and the results below are still the ones you applied before.
        </p>
      );
    case 'clarify':
      return (
        <p role="status">
          {describeClarification(snapshot.reason)} You can also reword your text and try again.
        </p>
      );
    case 'unsupported':
      return <p role="status">{describeUnsupported(snapshot.reason)}</p>;
    case 'unavailable':
      return <p role="status">{describeInterpretationError('disabled', null)}</p>;
    case 'error':
      return <p role="alert">{describeInterpretationError(snapshot.kind, snapshot.retryAfterMs)}</p>;
  }
}

// "Describe it in words": the text goes to the server on an explicit click, and what comes back only fills the
// editable filters below. Nothing here searches, and the manual filters work whatever this part says.
export function RunSearchInterpreter({ onInterpret, onTextChange, snapshot, text }: RunSearchInterpreterProps) {
  const problem = text === '' ? null : interpretationTextProblem(text);
  const empty = text.trim() === '';
  const blocked = snapshot.status === 'interpreting' || snapshot.status === 'unavailable';
  const characters = [...text].length;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!blocked && !empty && problem === null) {
      onInterpret();
    }
  };

  return (
    <form aria-label="Describe your search" className="search-interpreter" onSubmit={submit}>
      <label>
        Describe the runs you want (English or Russian)
        <textarea
          aria-describedby="search-interpreter-disclosure"
          onChange={(event) => onTextChange(event.target.value)}
          placeholder="Runs of at least 5 km from last month, longest first"
          rows={2}
          value={text}
        />
      </label>
      <p className="search-interpreter__disclosure" id="search-interpreter-disclosure">
        {INTERPRETATION_DISCLOSURE}
      </p>
      <div className="search-interpreter__actions">
        <button disabled={blocked || empty || problem !== null} type="submit">
          {snapshot.status === 'interpreting' ? 'Interpreting…' : 'Interpret'}
        </button>
        <span className="search-interpreter__count">
          {characters}/{INTERPRETATION_TEXT_MAX}
        </span>
      </div>
      {problem !== null && <p className="search-filters__errors" role="alert">{problem}</p>}
      <div className="search-interpreter__outcome">
        <Outcome snapshot={snapshot} />
      </div>
    </form>
  );
}
