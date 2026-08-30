/* === VIVENTIUM START === Thin legacy adapter for typed terminal-callback transactions. === */
const mongoose = require('mongoose');
const { createGlassHiveTerminalCallbackTransactionService } = require('@librechat/api');

module.exports = createGlassHiveTerminalCallbackTransactionService(mongoose);
/* === VIVENTIUM END === */
