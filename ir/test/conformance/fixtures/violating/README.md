# Fixture: violating

One session, `s1`, arranged to breach every compiled provision exactly where `expected.tsv` says. Each line of that file cites the provision it exercises (R2.7), so the coverage table and the citation lint see these as the tests for ACS-REQ-0001 through ACS-REQ-0018, ACS-REQ-0020, ACS-REQ-0022, ACS-REQ-0023, and the V7 provisions ACS-REQ-0027, ACS-REQ-0060, ACS-REQ-0062, ACS-REQ-0092, ACS-REQ-0134 and ACS-REQ-0138.

The breaches, by provision:

- ACS-REQ-0001: response 20 failed `response-envelope.json` at `/result/reasoning`.
- ACS-REQ-0002: request 4 was a batch, the Guardian does not support batching, and it answered with a decision rather than -32600.
- ACS-REQ-0003: the DENY at 20 carries no `reasoning`.
- ACS-REQ-0004: the DEFER at 40 lacks `resolution_timeout_ms` and `timeout_decision`.
- ACS-REQ-0005: the DEFER at 40 gives reason `vibes`.
- ACS-REQ-0006: two DEFERs against a bound of one.
- ACS-REQ-0007: hook 2 fired before the handshake at 3.
- ACS-REQ-0008: for decision 20 the agent layer ran (order 1) before the deterministic layer (order 2).
- ACS-REQ-0009: `p2` derives from `p9`, which never appeared in the session.
- ACS-REQ-0010: `p2` is `agent_generated` and `trusted` while its ancestor `p1` is `untrusted`; the witness carries the path.
- ACS-REQ-0011: `Intent.parsed` at step 4 holds `send`, absent at establishment (step 2) and never granted by an extension.
- ACS-REQ-0012: a rejected modification at step 4 with no audit event.
- ACS-REQ-0013: entry `e1` claims `hX`; recomputation gives `hY`.
- ACS-REQ-0014: two distinct objects share `provenance_id` `p1` (reported in both orders, as the rule is symmetric).
- ACS-REQ-0015: the client offers 0.9.0, the Guardian supports 0.1.0, and the handshake was not refused with -32001.
- ACS-REQ-0016: the content-bearing `agentResponse` at 6 was decided at 60 with no `chain_hash` published.
- ACS-REQ-0017: the `chain_hash` published at 20 is not covered by the response signature.
- ACS-REQ-0018: request 4's signature is invalid and its response is a decision, not -32004.
- ACS-REQ-0020: a chain mismatch observed at 6 with no audit event.
- ACS-REQ-0022: archival preserved only `chain_hash`.
- ACS-REQ-0023: the Approver `approver-1` resolved 60 without being verified.
- ACS-REQ-0027: `p1` came in as `user_input` but was populated `untrusted`; §7.2's default for that channel is `trusted`.
- ACS-REQ-0060 and ACS-REQ-0062: entry `e1` carries `timestamp` and `provenance_summary` but no `request_hash` (the §8.1 SHOULD, and the ACS-Audit MUST, fire on the same field).
- ACS-REQ-0092: the DEFER at 40 was logged with `reasoning` but no `model_identifier`.
- ACS-REQ-0134: the session never emitted `agbom/snapshot`, so every content-bearing hook (2, 4, 5, 6) fired without one; the differential does not scope by profile, so these tuples are raw and would be `not-activated` in a report unless the session negotiated ACS-Inspect.
- ACS-REQ-0138: the Guardian advertises `ML-DSA-65` but not `SLH-DSA-128s`, which ACS-Crypto also requires.
