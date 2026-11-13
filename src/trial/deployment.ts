/** Explicit allowlist: the management API key never belongs in function env. */
export function deploymentEnvironment(
  input: Record<string, unknown>,
  digest: string,
  expiresAt: number,
): Record<string, string> {
  if (
    !/^[a-f0-9]{64}$/.test(digest) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt > Date.now() + 20 * 60000
  )
    throw new Error("Invalid probe digest or expiry (maximum 20 minutes)");
  const env: Record<string, string> = {};
  for (const key of ["DATABASE_URL", "DATABASE_URL_UNPOOLED"]) {
    const value = input[key];
    if (typeof value !== "string")
      throw new Error("Missing restricted connection");
    const url = new URL(value);
    if (
      url.protocol !== "postgresql:" ||
      url.username !== "berth_runtime" ||
      url.pathname !== "/neondb" ||
      !url.hostname.endsWith(".us-east-2.aws.neon.tech") ||
      !["require", "verify-full"].includes(
        url.searchParams.get("sslmode") ?? "",
      )
    )
      throw new Error("Expected restricted Ohio connection");
    env[key] = value;
  }
  if (
    typeof input.BERTH_TRIAL_TOKEN !== "string" ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(input.BERTH_TRIAL_TOKEN)
  )
    throw new Error("Invalid private trial token");
  return {
    ...env,
    NEON_AI_GATEWAY_TOKEN: "disabled-for-berth-probe",
    AWS_ACCESS_KEY_ID: "disabled-for-berth-probe",
    AWS_SECRET_ACCESS_KEY: "disabled-for-berth-probe",
    BERTH_TRIAL_TOKEN: input.BERTH_TRIAL_TOKEN,
    BERTH_BUILD_DIGEST: digest,
    BERTH_PROBE_EXPIRES_AT: String(expiresAt),
  };
}
