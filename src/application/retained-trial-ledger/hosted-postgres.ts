import { Client, type ClientConfig } from "pg";

/** Connection settings validated by Inventory or Retry before they open a hosted session. */
export interface HostedPostgresConfig extends ClientConfig {
  requireChannelBinding: boolean;
}

const plus = "SCRAM-SHA-256-PLUS";

// pg 8.23.1 binds these methods on the client during connect. Its public option
// only prefers binding. Keep the private hooks here and recheck the loopback
// authentication tests when the driver pin changes.
const postgresHandshake = Client.prototype as Client & {
  _handleAuthSASL(message: { mechanisms: string[] }): void;
  _handleAuthSASLFinal(message: { data: string }): void;
  _handleReadyForQuery(message: unknown): void;
};

/** Gate pg's handshake on verified SCRAM-PLUS while leaving its TLS and SCRAM implementation in charge. */
class RequiredChannelBindingClient extends Client {
  #binding: "pending" | "verified" | "failed" = "pending";

  /** Fail the connection through pg's existing error and cleanup path. */
  #rejectBinding() {
    if (this.#binding === "failed") return;
    this.#binding = "failed";
    this.connection.emit(
      "error",
      Error("Database requires SCRAM-SHA-256-PLUS"),
    );
  }

  /** Reject a fallback request before the driver can send the password. */
  _handleAuthCleartextPassword() {
    this.#rejectBinding();
  }

  /** Reject a fallback request before the driver can send a password-derived response. */
  _handleAuthMD5Password() {
    this.#rejectBinding();
  }

  /** Allow exactly the bound mechanism even if the server offers plain SCRAM as well. */
  _handleAuthSASL(message: { mechanisms: string[] }) {
    if (this.#binding !== "pending" || !message.mechanisms.includes(plus)) {
      this.#rejectBinding();
      return;
    }
    postgresHandshake._handleAuthSASL.call(this, { mechanisms: [plus] });
  }

  /** pg clears the SCRAM session only after verifying the server signature. */
  _handleAuthSASLFinal(message: { data: string }) {
    if (this.#binding !== "pending") return;
    const client = this as Client & {
      saslSession?: { mechanism: string } | null;
    };
    const mechanism = client.saslSession?.mechanism;
    postgresHandshake._handleAuthSASLFinal.call(this, message);
    if (mechanism === plus && client.saslSession === null) {
      this.#binding = "verified";
    } else {
      this.#rejectBinding();
    }
  }

  /** Reject trust authentication and incomplete exchanges before connect can resolve. */
  _handleReadyForQuery(message: unknown) {
    if (this.#binding !== "verified") {
      this.#rejectBinding();
      return;
    }
    postgresHandshake._handleReadyForQuery.call(this, message);
  }
}

/** Keep pg's preferred channel binding for URLs that omit the option. */
export function hostedPostgresClient(config: HostedPostgresConfig): Client {
  return config.requireChannelBinding
    ? new RequiredChannelBindingClient(config)
    : new Client(config);
}
