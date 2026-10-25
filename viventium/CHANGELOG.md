# Viventium fork changes

## Unreleased

- Retain authenticated Telegram messages before the ordering dependency wait. Return the saved
  input receipt on an ordering failure and release only the caller's unused preparation lease.
  Invalid preparation and source-only commands do not create input records.
- Bound the existing monotonic Redis ordering command to five seconds. A late command cannot
  rewind a newer source or admit work. Durable streams reconnect by default; cache-only defaults
  and explicit operator reconnect limits remain unchanged.
- Prepare retained sources independently, then defer later admission while an earlier recoverable
  source remains unprepared. Recovery uses current saved ancestry and keeps cancellation identity
  stable when old startup metadata arrives late.

These changes use the existing input, lease, source-order and delivery owners. They do not replay
accepted tool actions or change provider selection. The parent Telegram adapter owns the visible
saved-message notice. Publication does not install these bytes in an existing runtime.
