/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
 * === VIVENTIUM END === */

// Update balances for specified users
// Usage: Set UPDATE_BALANCE_EMAILS environment variable with comma-separated emails
// Or pass emails as command-line arguments to the shell script

const emails = process.env.UPDATE_BALANCE_EMAILS
  ? process.env.UPDATE_BALANCE_EMAILS.split(',').map(e => e.trim())
  : [];

if (emails.length === 0) {
  print('Error: No emails provided. Set UPDATE_BALANCE_EMAILS environment variable or pass emails as arguments.');
  quit(1);
}

// Amount to set - can be overridden via UPDATE_BALANCE_AMOUNT env var
// Default: 100 billion tokenCredits
const LARGE_AMOUNT = process.env.UPDATE_BALANCE_AMOUNT
  ? parseInt(process.env.UPDATE_BALANCE_AMOUNT, 10)
  : 100000000000;

print(`Updating balances for ${emails.length} user(s)...`);
print(`Amount to set: ${LARGE_AMOUNT.toLocaleString()} tokenCredits`);
print('');

const db = db.getSiblingDB('LibreChat');
let successCount = 0;
let errorCount = 0;

for (const email of emails) {
  try {
    // Find user by email (email is stored lowercase in the database)
    const user = db.users.findOne({ email: email.toLowerCase().trim() });

    if (!user) {
      print(`❌ User not found: ${email}`);
      errorCount++;
      continue;
    }

    // Update or create balance record
    const result = db.balances.updateOne(
      { user: user._id },
      {
        $set: {
          tokenCredits: LARGE_AMOUNT
        }
      },
      { upsert: true }
    );

    if (result.modifiedCount > 0 || result.upsertedCount > 0) {
      print(`✅ Updated balance for: ${email} (User ID: ${user._id})`);
      successCount++;
    } else {
      print(`⚠️  No changes made for: ${email}`);
    }
  } catch (error) {
    print(`❌ Error updating balance for ${email}: ${error.message}`);
    errorCount++;
  }
}

print('');
print('Summary:');
print(`  ✅ Successfully updated: ${successCount}`);
print(`  ❌ Errors: ${errorCount}`);
print(`  📧 Total processed: ${emails.length}`);

if (errorCount > 0) {
  quit(1);
}
