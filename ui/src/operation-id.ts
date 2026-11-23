const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** Match the canonical operation identifier used by the retained read routes. */
export function isOperationId(value: string) {
  return uuid.test(value);
}
