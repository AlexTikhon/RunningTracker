import { organizationLabel, type OrganizationsState } from './organization-selection.js';

interface OrganizationPickerProps {
  // Switching is off while a run exists: the run belongs to the organization it was started in.
  locked: boolean;
  onChoose: (organizationId: string) => void;
  onRetry: () => void;
  selected: string | null;
  state: OrganizationsState;
}

// The organization every view works in, chosen from the memberships the server reports. Nothing here asks the
// person for an identifier.
export function OrganizationPicker({ locked, onChoose, onRetry, selected, state }: OrganizationPickerProps) {
  if (state.status === 'idle') {
    return null;
  }
  if (state.status === 'loading') {
    return <section className="org-picker" aria-label="Organization" role="status">Loading your organizations…</section>;
  }
  if (state.status === 'error') {
    return (
      <section className="org-picker org-picker--error" aria-label="Organization" role="alert">
        <span>Your organizations could not be loaded. {state.message}</span>
        <button onClick={onRetry} type="button">Try again</button>
      </section>
    );
  }
  if (state.organizations.length === 0) {
    return (
      <section className="org-picker org-picker--empty" aria-label="Organization" role="status">
        <strong>No organization yet</strong>
        <span>
          Your account is signed in but is not a member of any organization. Ask the organizer to add you, then reload this page.
        </span>
      </section>
    );
  }
  if (state.organizations.length === 1 && selected !== null) {
    return (
      <section className="org-picker" aria-label="Organization">
        <span>Organization</span>
        <strong title={selected}>{organizationLabel(selected, state.organizations)}</strong>
      </section>
    );
  }
  return (
    <section className="org-picker" aria-label="Organization">
      <label htmlFor="organization-select">Organization</label>
      <select
        disabled={locked}
        id="organization-select"
        onChange={(event) => onChoose(event.target.value)}
        value={selected ?? ''}
      >
        {selected === null && <option value="">Choose an organization…</option>}
        {state.organizations.map((organizationId) => (
          <option key={organizationId} value={organizationId}>
            {organizationLabel(organizationId, state.organizations)}
          </option>
        ))}
      </select>
      {locked && <span>Finish and clear the current run to switch organization.</span>}
    </section>
  );
}
