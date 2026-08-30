/* === VIVENTIUM START ===
 * Feature: Shared scheduled failure truth.
 * Purpose: Keep /api as the installed-artifact path adapter while packages/api owns behavior.
 * === VIVENTIUM END === */

const fs = require('fs');
const path = require('path');
const {
  createScheduledFailureContractService,
  defaultScheduledFailureContract,
} = require('@librechat/api');

const contractPath = path.join(
  __dirname,
  '../../../../viventium/source_of_truth/scheduled_failure_contract.v1.json',
);
const service = createScheduledFailureContractService({
  contractPath,
  readFile: fs.readFileSync,
});

module.exports = { contractPath, defaultScheduledFailureContract, ...service };
