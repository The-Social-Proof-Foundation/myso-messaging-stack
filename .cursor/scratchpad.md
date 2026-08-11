# Fix: sender must not get unread badges

## Background and Motivation
Sharing a post (or sending any message) while not in that thread was bumping the sender’s Messages-tab badge. Only the recipient should get unread.

## Key Challenges and Analysis
- iOS unread already no-ops when `latestOrder <= localReadUpto`.
- Open-thread sends advance watermark via `markLocalRead`; `PostSendService` did not.
- Relayer correctly fans `group.activity` to all members (including sender) for sort/preview; push already skips sender.

## High-Level Task Breakdown
1. `noteOwnOutbound` / `clearOwnOutbound` + consume on `group.activity` → `markRead`
2. Wire `PostSendService` + `ChatThreadViewController`
3. Document in `ClientSide-iOS.md`

## Project Status Board
- [x] Inbox own-outbound hooks + activity consume → markRead
- [x] Wire PostSendService
- [x] Wire ChatThreadViewController
- [x] Docs ClientSide-iOS.md

## Executor’s Feedback or Assistance Requests
None.

## Lessons
Own-send credits expire after 30s so a missed `group.activity` cannot swallow a later real inbound as “own.”
