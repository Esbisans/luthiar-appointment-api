// Loads .env.test BEFORE anything else imports process.env.
// Configured as `setupFiles` in jest-e2e.json so it runs in the Jest
// host's init phase (before the modules under test evaluate).
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as dotenv from 'dotenv';

const envPath = path.resolve(__dirname, '..', '..', '.env.test');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath, override: true });
}
