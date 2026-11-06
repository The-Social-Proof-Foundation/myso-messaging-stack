# E2EE Protocol v2: Content Envelope

Normative wire format for content envelope v2 (CEv2), implemented by the TS SDK (`src/content/envelope.ts`)
and iOS (`MessagingContentEnvelope.swift`). Every decoder must accept every encoder's output; JSON key order
is not significant, but the header and padding rules are exact. Shared test vectors live in
`ts-sdks/packages/myso-messaging-stack/test/vectors/content-envelope-v2.json`.

## Why

In v1 the relayer stores a row `kind` (`text`, `poll`, …) and keeps reactions and pins in plaintext tables,
and message length leaks through ciphertext size. In v2 everything a member authors goes inside one
encrypted, padded envelope. The relayer sees only:

| Row `kind` | Meaning |
|---|---|
| `message` | Any timeline message (text, poll, …) — inner type hidden |
| `event` | Reaction, edit, delete, pin or poll vote — type and target hidden |
| `post`, `token_transfer`, `request_payment` | Still relayer-visible: public on-chain objects the relayer acts on (share counts, transfer verification). Their payload is a CEv2 envelope too. |
| `system` | Relayer-authored membership rows (unchanged, cleartext) |

## Plaintext layout

```
plaintext = 0x02 || u32_be(N) || json[N bytes, UTF-8] || 0x00 * padding
len(plaintext) = max(256, padme(5 + N))
```

The plaintext is then encrypted exactly as v1 (AES-256-GCM, group DEK, message AAD). Signatures are
unchanged: the v1/v2 canonical strings cover the ciphertext and the row `kind`.

`padme(L)` (Padmé, leaks O(log log L) bits, ≤ 12% overhead):

```
if L <= 1: return L
E = floor(log2(L))
S = floor(log2(E)) + 1
mask = (1 << (E - S)) - 1
return (L + mask) & ~mask
```

A decoder treats a plaintext as v2 only when **all** hold: byte 0 is `0x02`; `5 + N <= len`; `len` equals
`max(256, padme(5 + N))`; every padding byte is `0x00`; the JSON parses to an object whose `t` is a known
string. Anything else is a v1 plaintext (raw UTF-8 text, or the v1 payment/post JSON).

## JSON

Keys are short to save envelope space. Unknown keys are ignored; unknown `t` / `e.type` values make the
message render as "Unsupported message" rather than fail.

### Messages

```json
{ "t": "text", "text": "hi", "att": [ ... ] }
```

| `t` | Row kind | `text` holds |
|---|---|---|
| `text` | `message` | Message text |
| `poll` | `message` | Poll body (same string a v1 poll carried) |
| `post` | `post` | Same string a v1 post share carried (`PostShareEnvelope`) |
| `token_transfer`, `request_payment` | same | Same JSON a v1 payment carried |

`att` (optional) replaces the relayer-visible `attachments[]` column, which is empty for v2 rows.

### Attachment v2

```json
{ "id": "<storageId>", "k": "<hex 32-byte file key>", "n": "<hex 12-byte nonce>",
  "name": "photo-1.jpg", "mime": "image/jpeg", "size": 12345,
  "poster": { "id": "...", "k": "...", "n": "..." }, "dur": 4200, "w": 1080, "h": 1920 }
```

File bytes are `AES-256-GCM(key = k, nonce = n, aad = UTF-8("myso-file-v2"))`, with a fresh random key per
file (and per poster). The key travels only inside the envelope, so it inherits the envelope's protection:
the MyData gate today, plus MLS forward secrecy from M4.

### Events

```json
{ "t": "event", "e": { "type": "reaction", "target": "<messageId>", "emoji": "👍", "add": true } }
{ "t": "event", "e": { "type": "edit", "target": "<messageId>", "text": "fixed typo", "att": [ ... ] } }
{ "t": "event", "e": { "type": "delete", "target": "<messageId>" } }
{ "t": "event", "e": { "type": "pin", "target": "<messageId>", "pinned": true } }
{ "t": "event", "e": { "type": "poll_vote", "target": "<messageId>", "options": [0, 2] } }
```

Folding rules (applied in relayer `order`; an event is ignored unless its `order` is greater than its
target's):

- **reaction**: state per `(target, emoji, sender)` is the latest `add`. `emoji` is NFC-normalized.
- **edit**: valid only when the event sender equals the target's sender; the latest valid edit replaces
  `text` and `att`, and marks the message edited.
- **delete**: valid only when the event sender equals the target's sender; the target renders as
  deleted. The client also calls `DELETE /messages/:id` so the relayer drops the ciphertext.
- **pin**: latest `pinned` per target, any member.
- **poll_vote**: latest vote per `(target, sender)`.

Events never appear in the timeline or in inbox previews.

## Relayer behaviour

- `POST /messages` accepts kinds `message` and `event`. For those rows `attachments` must be empty and
  `metadata` absent.
- `GET /messages?…&limit=N` counts only non-`event` rows toward `N` and also returns every `event` row
  inside the returned order range, so a page of reactions never hides messages.
- Unread counts exclude `event` rows.
- An `event` POST may carry `notify_wallets` (members to push, e.g. a reaction's target author) and
  `notification_envelopes`. The relayer pushes only those wallets and counts them in
  `reaction_unread_count`. It learns who was notified, never what the event was.

## Group flag

A group writes v2 when its on-chain metadata `data["e2ee"]` is `"v2"` (set by a `MetadataAdmin`;
`"mls1"` from M4). Every v2-capable client reads both formats in every group, so the flag only gates
writing.
