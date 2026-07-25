# Stellar BatchPay

## What Is This?

Stellar BatchPay is a toolkit for sending many transfers on Stellar in two ways:

- **Batch Payments**: immediate transfers sent in efficient transaction batches.
- **Batch Vesting**: time-locked allocations deposited once and claimable later.

Think of it like this: if you need to process payouts for hundreds of recipients, you can either pay them now (batch payments) or lock funds until a future date (batch vesting), all from one project.

## Core Features

- **Immediate batch payouts** for payroll, vendor settlements, rewards, and mass distributions.
- **Time-locked batch vesting** for grants, milestone payouts, token unlock schedules, and delayed compensation.
- **CSV/JSON friendly workflow** for upload, validation, and processing.
- **Stellar-aware batching** that respects network operation limits.
- **Detailed result visibility** for processed transactions and recipient-level outcomes.

## Community

Join the Stellar BatchPay community on Telegram to ask questions, discuss ideas, report issues, and connect with contributors.

[Join the Telegram Group](https://t.me/+TLkxWuvduWM4MTRk)

---

## The Problem It Solves

**Without this tool:**
- You'd need to manually send each payment individually
- You'd have to sign each transaction separately
- Processing hundreds of payments would take hours or days
- You'd be prone to making mistakes with manual entry

**With Stellar BatchPay:**
- Upload a list of payments (in CSV or JSON format)
- The system automatically groups them into efficient batches
- All payments are signed and sent in seconds
- You get a detailed report showing exactly what succeeded and what failed

For teams that need delayed distribution, the project also supports **batch vesting** so funds can be allocated now and unlocked at a specific future time.

---

## How It Works (Simple Version)

1. **You prepare a list** of who gets paid and how much
2. **You upload the file** to the web interface or use the command-line tool
3. **The system validates** everything is correct
4. **It automatically groups payments** into batches (Stellar limits how many per transaction)
5. **All payments are signed and submitted** to the Stellar blockchain
6. **You get a report** showing exactly what happened

For vesting flows, the sender deposits funds for many recipients with a shared unlock time, and recipients claim once the lock expires.

---

## How It Works (Technical Version)

The system has three main parts:

### 1. Core Library (`lib/stellar/`)
The "engine" that does all the work:
- **Reads your payment files** (JSON or CSV)
- **Checks everything is valid** (correct addresses, valid amounts, etc.)
- **Groups payments into batches** following Stellar's rules (max 100 operations per transaction)
- **Builds the transactions** and signs them with your Stellar account
- **Submits to Stellar** and gets back results

### 2. Web Interface (`app/` and `components/`)
A browser-based tool where you can:
- Upload a CSV or JSON file with your payment list
- See a preview of what will be sent (addresses, amounts, asset types)
- Choose whether to use testnet (practice) or mainnet (real money)
- Click a button to send everything
- See detailed results including transaction IDs

### 3. Command-Line Tool (`cli/`)
For developers and automated systems:
- Run commands from your terminal
- Automate bulk payments in scripts
- Integrate with other systems
- Useful for technical users and systems integration

### 4. Batch Vesting Contract (`contracts/batch-vesting/`)
A Soroban smart contract for time-locked distribution:
- **`deposit(...)`** stores vesting records for multiple recipients in one call
- Accepts a common **`unlock_time`** for the batch
- Enforces **`MAX_BATCH_SIZE = 100`** for both deposits and batch revocations
- Transfers total tokens from sender to the contract at deposit time
- **`claim(...)`** lets each recipient withdraw only after unlock time

---

## Getting Started (Non-Technical Users)

### What You Need
- A Stellar account (like a digital wallet)
- The secret key for your account (keep this private!)
- A list of people to pay and amounts (as a CSV or JSON file)
- Enough money in your account for all the payments

### Quick Steps

1. **Start the application:**
   ```bash
   npm run dev
   ```
   Then open http://localhost:3000 in your browser

2. **Prepare your payment file** (see examples below)

3. **Click "Choose File"** and upload your payment list

4. **Review the preview** to make sure everything looks correct

5. **Select testnet (to practice) or mainnet (real payments)**

6. **Click "Submit Batch"** and wait for it to process

7. **Check the results** to see what succeeded and failed

> Note: The current web flow is focused on direct batch payments. Batch vesting is implemented in the smart contract layer and can be integrated into app/automation workflows as needed.

---

## Payment File Formats

### CSV Format (Easiest for Spreadsheets)

```csv
address,amount,asset
GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER,10.50,XLM
GBJCHUKZMTFSLOMNC7P4TS4VJJBTCYL3AEYZ7R37ZJNHYQM7MDEBC67,25.00,XLM
GDZST3XVCDTUJ76ZAV2HA72KYXP7NQJLX7NBXGQVVFEWZYZK7WPVNKYA,100.00,USDC:GBUQWP3BOUZX34ULNQG23RQ6F4BWFIDBPPK7B7ILALX7DNZY5GJUSYM
```

**Columns:**
- **address**: The Stellar wallet address of the person getting paid (always starts with 'G')
- **amount**: How much to send (can have decimals like 10.50)
- **asset**: What type of money to send
  - `XLM` for regular Stellar lumens
  - `ASSETNAME:ISSUER` for other assets (like `USDC:GBUQWP3BOUZX34ULNQG23RQ6F4BWFIDBPPK7B7ILALX7DNZY5GJUSYM`)

### JSON Format (For Programmers)

```json
[
  {
    "address": "GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER",
    "amount": "10.50",
    "asset": "XLM"
  },
  {
    "address": "GBJCHUKZMTFSLOMNC7P4TS4VJJBTCYL3AEYZ7R37ZJNHYQM7MDEBC67",
    "amount": "25.00",
    "asset": "XLM"
  },
  {
    "address": "GDZST3XVCDTUJ76ZAV2HA72KYXP7NQJLX7NBXGQVVFEWZYZK7WPVNKYA",
    "amount": "100.00",
    "asset": "USDC:GBUQWP3BOUZX34ULNQG23RQ6F4BWFIDBPPK7B7ILALX7DNZY5GJUSYM"
  }
]
```

---

## Batch Vesting

Batch vesting is for **time-locked payments**. Instead of transferring funds to recipients immediately, you deposit tokens into a vesting contract now, set an unlock timestamp, and recipients claim later.

### How Time-Locked Payments Work

1. **Sender deposits** tokens for many recipients in one contract call.
2. Each recipient gets a vesting record with `amount` and `unlock_time`.
3. Funds remain locked in the contract until unlock time is reached.
4. Recipient calls `claim` to receive funds after unlock time.

### Good Use Cases

- **Payroll with cliff dates** (payday unlocks).
- **Contributor or community grants** with delayed release.
- **Milestone-based payouts** that should only unlock after agreed dates.
- **Token distribution schedules** where immediate liquidity is not desired.

### Payments vs Vesting (At a Glance)

| Capability | Batch Payments | Batch Vesting |
| --- | --- | --- |
| When recipient gets funds | Immediately after tx confirmation | After `unlock_time` and claim |
| Main primitive | Stellar payment operations | Soroban vesting contract storage + claim |
| Typical use | Operational payouts | Grants, cliffs, milestone unlocks |
| Custody before recipient receives | Sender until sent | Contract escrow until unlock |

### Contract Interface (Current Implementation)

Implemented in `contracts/batch-vesting/src/lib.rs`:

- `deposit(env, sender, token, recipients, amounts, unlock_time)`
- `batch_revoke(env, caller, recipients, token, unlock_time)`
- `revoke(env, caller, recipient, index)` - Full revocation of unvested schedules
- `revoke_partial(env, caller, recipient, index, amount_to_revoke)` - Partial revocation
- `claim(env, recipient, token)`

`deposit` validates recipient/amount arrays, rejects batches larger than 100 entries, stores per-recipient vesting state, and transfers total token amount into contract custody. `batch_revoke` applies the same 100-recipient limit so oversized revocation calls fail before doing per-recipient work. `claim` enforces the lock and transfers vested funds to the recipient.

#### Revocation Semantics

**Full Revocation (`revoke`):**
- Revokes an entire vesting schedule before it fully vests
- Calculates vested amount at current time using the same logic as `claim`
- Returns unvested portion to sender
- Automatically transfers any vested-but-unclaimed amount to recipient
- Cannot revoke after `end_time` (fully vested schedules)

**Partial Revocation (`revoke_partial`):**
- Reduces the `total_amount` of a vesting schedule without removing it entirely
- Useful for adjusting vesting when employment status changes (e.g., full-time to part-time)
- **Protected Amount:** Cannot revoke tokens that have already vested, even if unclaimed
- Revocable amount = `total_amount - max(released_amount, vested_now)`
- This ensures recipients keep all tokens they've earned under the vesting schedule
- The schedule remains active with the reduced `total_amount`
- `released_amount` (claimed tokens) remains unchanged

**Important:** Both revocation functions protect vested tokens. The sender can only revoke the truly unvested portion, ensuring recipients receive what they've earned according to the vesting timeline.

---

## Important Things to Know

### Testnet vs Mainnet
- **Testnet**: Practice mode. Money isn't real, useful for testing before sending real money.
- **Mainnet**: Real money. Only use this when you're sure everything is correct.

### Costs
Each transaction costs a small fee (about 0.00001 XLM per operation). The system automatically calculates and deducts these fees.

### Limits
- Maximum 100 payments per transaction (the system automatically splits larger batches)
- Maximum 100 vesting recipients per `deposit` or `batch_revoke` call
- You can't undo a payment once submitted
- You need enough money in your account for all payments plus fees
- For vesting, recipients cannot claim before unlock time

### Safety
- **Never share your secret key** with anyone
- Always test with testnet first
- Double-check addresses before sending real money
- The system validates everything before sending

---

## Real-World Example

Let's say you need to pay 250 influencers for promoting your product:

1. **Prepare a CSV file** with all 250 addresses and amounts
2. **Upload to the web interface**
3. **System automatically creates 3 transactions** (250 payments ÷ 100 max per transaction = 3 batches)
4. **All 3 are signed and submitted** in seconds
5. **You get a report** showing all 250 payments with their status

Without this tool, you'd be manually sending payments for hours. With it? Done in seconds.

### Vesting Example

You need to allocate milestone grants to 40 builders, but unlock only at quarter end:

1. Deposit all 40 allocations to the batch vesting contract with a shared unlock timestamp
2. Contract escrows total tokens immediately
3. Each builder claims after the unlock date
4. No manual release run is needed at unlock time

---

## For Developers

For a detailed guide on architecture, local development setup, and contract development, see the [Development Guide](DEVELOPMENT.md).

### Installation

```bash
bun install
```

### Environment Variables

Copy the example environment file and configure it for your setup:

```bash
cp .env.example .env
```

See `.env.example` for all available variables, including client-side (`NEXT_PUBLIC_*`) and server-only options.

### Using the Web Interface

```bash
bun run dev
# Open http://localhost:3000
```

### Using the Command Line

Run the CLI using Bun (the project's standard engine for TS scripts):

```bash
STELLAR_SECRET_KEY="S..." bun run cli -- <command> [flags]
```

For example, to validate a payment instructions file:
```bash
bun run cli -- validate --input examples/payments.json
```

Or run CLI scripts directly with Bun:
```bash
STELLAR_SECRET_KEY="S..." bun cli/index.ts submit --input examples/payments.json --network testnet
```

### Programmatic Imports

The package exports a public TypeScript/ESM API from the root.

```typescript
import { validatePaymentInstructions, parsePaymentFile } from 'stellar-batch-pay';

const results = validatePaymentInstructions(payments);
```

For server-side ONLY services:
```typescript
import { StellarService } from 'stellar-batch-pay/lib/stellar/server.js';
```

---

## What Information You Get Back

After submitting, you'll see:

- **Total recipients processed**: How many people got paid
- **Total amount sent**: Combined value of all payments
- **Number of transactions**: How many blockchain transactions were used
- **Per-recipient status**: For each person, did they get paid or was there an error?
- **Transaction IDs**: The blockchain reference for each transaction (so you can verify on a blockchain explorer)
- **Timestamp**: When everything was processed

For vesting workflows, you should also track contract-level events/state such as deposit execution, recipient vesting records, unlock timestamp, and successful claims.

---

## Common Questions

**Q: What if one payment fails?**
A: Failed payments are reported individually in the batch result. You can review the errors and retry only the failed entries without resubmitting the full batch.

**Q: Can I cancel payments?**
A: No, once submitted to the blockchain, payments can't be undone. This is why testnet exists — test first!

**Q: How long does it take?**
A: Usually 3-5 seconds per transaction. So 250 payments would take about 10-15 seconds.

**Q: What if my payment file has 500 recipients?**
A: The system automatically splits it into 5 transactions (500 ÷ 100) and processes them all.

**Q: Can I use different types of money?**
A: Yes! In the same batch, you can send some people XLM, others USDC, others any asset on Stellar.

**Q: Is this secure?**
A: Your secret key never leaves your computer/browser. All processing happens locally or on your own server.

**Q: Does BatchPay store uploaded recipient or payroll data in browser storage?**
A: No. The new batch flow only keeps non-sensitive draft metadata, such as the current step and active job id, in session storage for crash recovery. Recipient addresses, payment amounts, validation results, and batch summaries are not persisted in browser storage and the draft metadata is cleared after successful submission or wallet disconnect.

---

## Webhook Integration

Stellar BatchPay supports outgoing webhooks to notify external systems when batch operations complete. All webhook requests include HMAC-SHA256 signatures for security.

### Registering a Webhook

Send a POST request to `/api/webhooks/register` with your webhook URL and the events you want to subscribe to:

```bash
curl -X POST http://localhost:3000/api/webhooks/register \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-system.com/webhook",
    "events": ["batch.completed", "batch.failed"]
  }'
```

The response will include a shared `secret` that you'll use to verify incoming webhook signatures.

### Verifying Webhook Signatures

All outgoing webhooks include an `x-webhook-signature` header containing an HMAC-SHA256 signature. You should verify this signature to ensure the webhook is authentically from Stellar BatchPay.

**Node.js/JavaScript example:**
```javascript
const crypto = require('crypto');

function verifyWebhook(payload, signature, secret) {
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
  
  return crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(expectedSignature, 'hex')
  );
}

// Express.js example
app.post('/webhook', (req, res) => {
  const signature = req.headers['x-webhook-signature'];
  const payload = req.body;
  
  if (!verifyWebhook(payload, signature, YOUR_WEBHOOK_SECRET)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  
  console.log('Verified webhook:', payload);
  res.json({ status: 'ok' });
});
```

**Python example:**
```python
import hmac
import hashlib

def verify_webhook(payload, signature, secret):
    expected = hmac.new(
        secret.encode('utf-8'),
        json.dumps(payload).encode('utf-8'),
        hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(signature, expected)
```

### Webhook Event Format

```json
{
  "event": "batch.completed",
  "payload": {
    "batchId": "...",
    "totalRecipients": 100,
    "successful": 98,
    "failed": 2
  },
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

---

## Need Help?

1. **Join our [Telegram community](https://t.me/+TLkxWuvduWM4MTRk)** for questions and discussions
2. **Check the examples** in the `examples/` folder
3. **Read error messages carefully** — they tell you exactly what went wrong
4. **Test with testnet first** — always
5. **Review the file format** — make sure addresses are correct
6. **Check the [Stellar documentation](https://developers.stellar.org/)**

---

## License

Open source and free to use.
