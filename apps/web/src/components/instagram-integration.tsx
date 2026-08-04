import type { IntegrationsSnapshot } from "../lib/server/integrations-data";
import {
  formatAccountType,
  formatDateTime,
  formatScopeName,
  formatUsername,
  presentCallbackOutcome,
  presentConnection,
  presentRequiredScopes,
  type CallbackOutcome,
  type IntegrationAccountView,
} from "../lib/instagram-integration";
import { InstagramDisconnectControl } from "./instagram-disconnect-control";
import { InstagramSyncControl } from "./instagram-sync-control";
import { PageHeader } from "./page-header";
import { StatusBadge } from "./status-badge";
import { EmptyState, ErrorSummary } from "./states";

/**
 * The Instagram integration configuration screen.
 *
 * Every value rendered here comes from a projection that cannot express
 * credential material, and provider failures arrive as a coarse outcome rather
 * than provider text, so there is no path by which a token or a raw provider
 * error reaches the page.
 */

const connectPath = "/api/integrations/instagram/connect";

export function InstagramIntegrations({
  expectedAccountId,
  outcome,
  snapshot,
}: Readonly<{
  expectedAccountId?: string | null;
  outcome: CallbackOutcome;
  snapshot: IntegrationsSnapshot;
}>) {
  // Resolved against the workspace's own accounts, so an identifier naming
  // nothing here simply leaves the message unnamed.
  const expected = snapshot.accounts.find((account) => account.accountId === expectedAccountId);
  const callback = presentCallbackOutcome(
    outcome,
    expected ? formatUsername(expected.username) : null,
  );

  return (
    <div className="page-stack">
      <PageHeader
        description="Review connection health for authorised Instagram professional accounts, reconnect when Instagram stops accepting a connection, and disconnect an account without losing imported history."
        title="Instagram integration"
      />

      {callback ? (
        <section
          aria-live="polite"
          className={`integration-callback integration-callback--${callback.tone}`}
        >
          <StatusBadge tone={callback.tone}>{callback.title}</StatusBadge>
          <p>{callback.description}</p>
        </section>
      ) : null}

      {snapshot.accounts.length === 0 ? (
        <NoAccountState canManage={snapshot.canManage} />
      ) : (
        <>
          <ul className="integration-list">
            {snapshot.accounts.map((account) => (
              <li key={account.accountId}>
                <IntegrationAccountCard account={account} canManage={snapshot.canManage} />
              </li>
            ))}
          </ul>
          {snapshot.canManage ? <AddAccountState /> : null}
        </>
      )}
    </div>
  );
}

/**
 * The control for connecting an account in addition to the ones already here.
 *
 * It posts to the same endpoint as reconnect and carries no account, which is
 * exactly what distinguishes the two: an unbound attempt accepts whichever
 * account is approved, a reconnect accepts only its own. The labels are
 * deliberately different words, because the label is all the operator has to
 * tell them apart.
 */
function AddAccountState() {
  return (
    <section className="state-panel">
      <h2>Connect another account</h2>
      <p>
        Add a second Instagram professional account to this workspace. Each account is imported and
        reported separately, and connecting one does not affect any account already connected.
      </p>
      <ConnectForm label="Connect another account" />
    </section>
  );
}

function NoAccountState({ canManage }: Readonly<{ canManage: boolean }>) {
  if (!canManage) {
    return (
      <EmptyState
        description="No Instagram account is connected to this workspace. An administrator can connect one."
        title="No Instagram account connected"
      />
    );
  }

  return (
    <section className="state-panel">
      <StatusBadge>Not connected</StatusBadge>
      <h2>No Instagram account connected</h2>
      <p>
        Connect an Instagram professional account to start importing Reels and their insights. You
        will be sent to Instagram to approve read-only access.
      </p>
      <ConnectForm label="Connect Instagram account" />
    </section>
  );
}

/**
 * Connect and reconnect are the same provider redirect, so both post to the
 * same endpoint. A form rather than a link keeps it a POST, which is what stops
 * a cross-site image or link from starting a connection.
 *
 * `accountId` is what separates the two: when it is present the attempt is
 * bound to that account and the callback refuses any other, and when it is
 * absent the attempt may connect whichever account is approved. The server
 * re-reads the account in this workspace, so a tampered value is refused rather
 * than trusted.
 */
function ConnectForm({ accountId, label }: Readonly<{ accountId?: string; label: string }>) {
  return (
    <form action={connectPath} className="integration-connect" method="post">
      {accountId ? <input name="accountId" type="hidden" value={accountId} /> : null}
      <button className="button button--primary" type="submit">
        {label}
      </button>
    </form>
  );
}

function IntegrationAccountCard({
  account,
  canManage,
}: Readonly<{ account: IntegrationAccountView; canManage: boolean }>) {
  const connection = presentConnection(account);
  const scopes = presentRequiredScopes(account.grantedScopes);
  const missingScopes = scopes.filter((scope) => !scope.granted);
  const headingId = `account-${account.accountId}`;

  return (
    <section aria-labelledby={headingId} className="integration-account">
      <header className="integration-account__header">
        <div>
          <h2 id={headingId}>{formatUsername(account.username)}</h2>
          <p className="integration-account__type">
            {formatAccountType(account.accountType)} account · Instagram Graph API{" "}
            {account.apiVersion}
          </p>
        </div>
        <StatusBadge tone={connection.tone}>{connection.label}</StatusBadge>
      </header>

      <p className="integration-account__summary">{connection.description}</p>

      {connection.action ? (
        <div className="integration-account__next">
          <ConnectForm
            accountId={account.accountId}
            label={
              connection.action === "RECONNECT" ? "Reconnect account" : "Reconnect this account"
            }
          />
        </div>
      ) : null}

      {missingScopes.length > 0 ? (
        <ErrorSummary
          description={`Reconnect the account and approve every requested permission. Missing: ${missingScopes
            .map((scope) => formatScopeName(scope.scope))
            .join(", ")}.`}
          title="Required permissions are missing"
        />
      ) : null}

      <dl className="integration-account__facts">
        <div>
          <dt>Connection expires</dt>
          <dd>{formatDateTime(account.expiresAt)}</dd>
        </div>
        <div>
          <dt>Last successful sync</dt>
          <dd>{formatDateTime(account.lastSuccessfulSyncAt)}</dd>
        </div>
        <div>
          <dt>Last checked</dt>
          <dd>{formatDateTime(account.lastValidatedAt)}</dd>
        </div>
      </dl>

      <div className="integration-account__scopes">
        <h3>Permissions</h3>
        <ul>
          {scopes.map((scope) => (
            <li key={scope.scope}>
              <StatusBadge tone={scope.granted ? "success" : "danger"}>
                {scope.granted ? "Granted" : "Missing"}
              </StatusBadge>
              <span>{formatScopeName(scope.scope)}</span>
            </li>
          ))}
        </ul>
      </div>

      {canManage && connection.state !== "DISCONNECTED" ? (
        <>
          {/* Offered only on a healthy connection: an import against a blocked
              credential fails in the worker and reads as a broken sync rather
              than as a connection needing attention. */}
          {connection.state === "CONNECTED" ? (
            <InstagramSyncControl accountId={account.accountId} />
          ) : null}
          <InstagramDisconnectControl
            accountId={account.accountId}
            username={formatUsername(account.username)}
          />
        </>
      ) : null}
    </section>
  );
}
