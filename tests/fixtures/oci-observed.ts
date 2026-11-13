/** Owner observations from 2026-11-13, not full recorded provider bodies.
 * No account identifiers, tokens granting access, keys or provider messages.
 * Payloads assembled around these facts in tests are synthetic.
 */
export const observedOciResponses = {
  newlyRegisteredKey: { status: 401 },
  singleGroup: { status: 200, headers: { "opc-next-page": "MQ==" } },
  verifiedTrial: { namespaceVerified: true, bucketCount: 0, metricCount: 0 },
} as const;
