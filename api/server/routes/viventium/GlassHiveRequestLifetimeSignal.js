/* === VIVENTIUM START ===
 * Feature: broker request-lifetime cancellation
 * Purpose: Bind provider cancellation to the active broker HTTP exchange without inheriting a
 * completed outer operation's signal. Exported separately so every terminal event is regression
 * tested without relying on which socket event Node happens to emit first. */
function requestLifetimeSignal(req, res) {
  const controller = new AbortController();
  const cleanup = () => {
    req.removeListener('aborted', abort);
    res.removeListener('close', abort);
    res.removeListener('finish', cleanup);
  };
  const abort = () => {
    if (!res.writableEnded && !controller.signal.aborted) {
      controller.abort('broker_client_disconnected');
    }
    cleanup();
  };
  req.once('aborted', abort);
  res.once('close', abort);
  res.once('finish', cleanup);
  return controller.signal;
}

module.exports = { requestLifetimeSignal };
/* === VIVENTIUM END === */
