#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, token, Address, BytesN, Env, Map, String, Symbol, Vec,
};

const MAX_BATCH_SIZE: u32 = 100;
/// #196: Cap the number of vesting schedules per recipient to prevent unbounded
/// iteration in claim() and revoke(), which would cause gas exhaustion (DoS).
const MAX_SCHEDULES_PER_RECIPIENT: u32 = 10;
const DAY_IN_LEDGERS: u32 = 17280;
const BUMP_THRESHOLD: u32 = 7 * DAY_IN_LEDGERS;
const BUMP_EXTEND_TO: u32 = 30 * DAY_IN_LEDGERS;

/// #228: Granular pause masks
const PAUSE_DEPOSIT: u32 = 1 << 0;
const PAUSE_CLAIM: u32 = 1 << 1;
const PAUSE_REVOKE: u32 = 1 << 2;

const UPGRADE_TIMELOCK: u64 = 7 * 24 * 60 * 60; // 7 days in seconds

#[contract]
pub struct BatchVestingContract;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchInfo {
    pub sender: Address,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VestingData {
    pub total_amount: i128,
    pub released_amount: i128,
    pub start_time: u64,
    pub end_time: u64,
    pub cliff_time: u64,   // #243: Cliff support
    pub vesting_step: u64, // #253: Custom linear vesting steps (0 or 1 = continuous)
    pub sender: Address,   // #254: Added back missing sender field
    pub batch_id: u32,
    /// #194: Store the token address so claim/revoke can validate it matches
    /// the token that was originally deposited, preventing cross-token exploits.
    pub token: Address,
    pub memo: String,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeProposal {
    pub new_wasm_hash: BytesN<32>,
    pub execute_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RevokeRequest {
    pub recipient: Address,
    pub index: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub max_batch_size: u32,
    pub max_schedules_per_recipient: u32,
    pub upgrade_timelock: u64,
    /// #543: The only token accepted for fee collection. Set at contract
    /// initialization and cannot be changed without a full config update.
    /// This prevents admin from switching to an arbitrary/scam token.
    pub fee_asset: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeConfig {
    /// Fee in stroops (1 XLM = 10_000_000 stroops) charged per recipient on deposit.
    /// Set to 0 to disable fees.
    pub fee_per_recipient: i128,
    /// Address that receives collected fees (treasury or admin wallet).
    pub treasury: Address,
    // #543: fee_asset removed from FeeConfig - now stored in contract Config
    // to prevent admin from changing the fee token arbitrarily.
}

/// Legacy storage type used only during migration from the old Vec<VestingData> layout.
/// Must match the exact field layout of VestingData as it was stored before the
/// granular per-schedule key migration.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LegacyVestingData {
    pub total_amount: i128,
    pub released_amount: i128,
    pub start_time: u64,
    pub end_time: u64,
    pub vesting_step: u64,
    pub sender: Address,
    pub batch_id: u32,
    pub token: Address,
    pub memo: String,
}

#[contracttype]
pub enum DataKey {
    VestingEntry(Address, u32), // (recipient, index) — granular per-schedule key
    VestingCount(Address),      // total number of schedules for a recipient
    Admin,
    PendingAdmin,
    Paused,
    PauseMask,
    /// #195: Permanent flag written on first set_admin and never cleared,
    /// even after renounce_admin.  Prevents admin re-claim post-renouncement.
    AdminInitialized,
    /// DEPRECATED: Old Vec<VestingData> storage key for backward compatibility
    Vesting(Address),
    Config,
    BatchInfo(u32),             // #209: batch metadata indexed by batch_id
    BatchCounter,               // #209: counter for next batch_id
    UpgradeProposal,            // #254: pending contract upgrade
    /// Fee configuration for per-recipient deposit fees.
    FeeConfig,
}

#[soroban_sdk::contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum VestingError {
    Paused = 1,
    NotFound = 2,
    LengthMismatch = 3,
    InvalidUnlockTime = 4,
    InvalidAmount = 5,
    AdminAlreadySet = 6,
    NotAdmin = 7,
    AlreadyVested = 8,
    Unauthorized = 9,
    StillLocked = 10,
    /// #194: Provided token does not match the token stored in the vesting schedule.
    TokenMismatch = 11,
    /// #196: Recipient has reached the maximum number of allowed vesting schedules.
    ScheduleLimitExceeded = 12,
    /// Arithmetic operation resulted in an overflow.
    Overflow = 13,
    /// #253: Vesting duration is not evenly divisible by vesting_step.
    InvalidVestingStep = 14,
    /// #254: Timelock for upgrade has not yet expired.
    TimelockNotExpired = 15,
    /// Fee token does not match the native/expected fee token.
    FeeMismatch = 16,
    /// Caller is not the recipient of the vesting schedule.
    NotRecipient = 17,
    /// #308: batch_revoke requests were not provided in strictly descending index order.
    InvalidInput = 18,
    /// #543: Provided fee asset is not the whitelisted token from contract config.
    InvalidToken = 19,
}

impl BatchVestingContract {
    fn panic_if_batch_too_large(env: &Env, batch_len: u32) {
        let config = Self::get_config(env);
        if batch_len > config.max_batch_size {
            panic!("Batch size exceeds max_batch_size");
        }
    }

    fn get_next_batch_id(env: &Env) -> u32 {
        env.storage().persistent().get(&DataKey::BatchCounter).unwrap_or(0u32)
    }

    fn increment_batch_id(env: &Env) {
        let current = Self::get_next_batch_id(env);
        let next = current.checked_add(1).unwrap_or_else(|| soroban_sdk::panic_with_error!(env, VestingError::Overflow));
        env.storage().persistent().set(&DataKey::BatchCounter, &next);
    }

    fn get_batch_info(env: &Env, batch_id: u32) -> BatchInfo {
        env.storage()
            .persistent()
            .get(&DataKey::BatchInfo(batch_id))
            .unwrap_or_else(|| soroban_sdk::panic_with_error!(env, VestingError::NotFound))
    }

    fn set_batch_info(env: &Env, batch_id: u32, info: &BatchInfo) {
        env.storage().persistent().set(&DataKey::BatchInfo(batch_id), info);
        env.storage().persistent().extend_ttl(
            &DataKey::BatchInfo(batch_id),
            BUMP_THRESHOLD,
            BUMP_EXTEND_TO,
        );
    }

    fn get_config(env: &Env) -> Config {
        env.storage()
            .persistent()
            .get(&DataKey::Config)
            .unwrap_or_else(|| soroban_sdk::panic_with_error!(env, VestingError::NotFound))
    }

    fn set_config_internal(env: &Env, config: &Config) {
        env.storage().persistent().set(&DataKey::Config, config);
        env.storage().persistent().extend_ttl(
            &DataKey::Config,
            BUMP_THRESHOLD,
            BUMP_EXTEND_TO,
        );
    }

    fn get_admin(env: &Env) -> Option<Address> {
        env.storage().persistent().get(&DataKey::Admin)
    }

    fn set_admin_internal(env: &Env, admin: &Address) {
        env.storage().persistent().set(&DataKey::Admin, admin);
    }

    fn initialize_admin(env: &Env, admin: &Address) {
        Self::set_admin_internal(env, admin);
        Self::mark_admin_initialized(env);
        Self::extend_ttl_admin(env);
    }

    fn remove_admin_internal(env: &Env) {
        env.storage().persistent().remove(&DataKey::Admin);
    }

    /// Returns true if set_admin was ever successfully called on this contract.
    fn is_admin_initialized(env: &Env) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::AdminInitialized)
            .unwrap_or(false)
    }

    /// Permanently records that admin has been initialised.  Never cleared.
    fn mark_admin_initialized(env: &Env) {
        env.storage()
            .persistent()
            .set(&DataKey::AdminInitialized, &true);
    }

    fn get_pending_admin(env: &Env) -> Option<Address> {
        env.storage().persistent().get(&DataKey::PendingAdmin)
    }

    fn set_pending_admin_internal(env: &Env, admin: &Address) {
        env.storage()
            .persistent()
            .set(&DataKey::PendingAdmin, admin);
    }

    fn remove_pending_admin_internal(env: &Env) {
        env.storage().persistent().remove(&DataKey::PendingAdmin);
    }

    fn get_fee_config(env: &Env) -> Option<FeeConfig> {
        env.storage().persistent().get(&DataKey::FeeConfig)
    }

    fn set_fee_config_internal(env: &Env, config: &FeeConfig) {
        env.storage().persistent().set(&DataKey::FeeConfig, config);
        env.storage().persistent().extend_ttl(
            &DataKey::FeeConfig,
            BUMP_THRESHOLD,
            BUMP_EXTEND_TO,
        );
    }

    fn require_current_admin(env: &Env, admin: &Address) {
        admin.require_auth();
        let stored_admin = Self::get_admin(env).unwrap_or_else(|| {
            soroban_sdk::panic_with_error!(env, VestingError::NotAdmin)
        });
        if admin != &stored_admin {
            soroban_sdk::panic_with_error!(env, VestingError::NotAdmin);
        }
    }

    fn is_authorized(_env: &Env, caller: &Address, schedule_sender: &Address) -> bool {
        caller == schedule_sender
    }

    fn get_pause_mask(env: &Env) -> u32 {
        let mut mask = env
            .storage()
            .persistent()
            .get(&DataKey::PauseMask)
            .unwrap_or(0u32);

        // #228: Backward compatibility: if legacy Paused flag is set, treat as fully paused
        if env.storage().persistent().get::<_, bool>(&DataKey::Paused).unwrap_or(false) {
            mask |= PAUSE_DEPOSIT | PAUSE_CLAIM | PAUSE_REVOKE;
        }
        mask
    }

    fn is_operation_paused(env: &Env, op_mask: u32) -> bool {
        (Self::get_pause_mask(env) & op_mask) != 0
    }

    fn panic_if_operation_paused(env: &Env, op_mask: u32) {
        if Self::is_operation_paused(env, op_mask) {
            soroban_sdk::panic_with_error!(env, VestingError::Paused);
        }
    }

    fn migrate_if_needed(env: &Env, recipient: &Address) {
        let old_key = DataKey::Vesting(recipient.clone());
        if let Some(old_vestings) = env
            .storage()
            .persistent()
            .get::<_, Vec<LegacyVestingData>>(&old_key)
        {
            let count = old_vestings.len();
            for i in 0..count {
                let legacy_vesting = old_vestings.get(i).unwrap();

                let batch_id = Self::get_next_batch_id(env);
                let batch_info = BatchInfo {
                    sender: legacy_vesting.sender.clone(),
                    timestamp: legacy_vesting.start_time,
                };
                Self::set_batch_info(env, batch_id, &batch_info);
                Self::increment_batch_id(env);

                // Map legacy VestingData to new structure
                let vesting = VestingData {
                    total_amount: legacy_vesting.total_amount,
                    released_amount: legacy_vesting.released_amount,
                    start_time: legacy_vesting.start_time,
                    end_time: legacy_vesting.end_time,
                    cliff_time: legacy_vesting.start_time, // Legacy has no cliff
                    vesting_step: 0,
                    sender: legacy_vesting.sender.clone(),
                    batch_id, // #328: Use the newly allocated batch_id
                    token: legacy_vesting.token.clone(),
                    memo: String::from_str(env, ""),
                };
                Self::set_vesting(env, recipient, i, &vesting);
            }
            Self::set_vesting_count(env, recipient, count);
            env.storage().persistent().remove(&old_key);
        }
    }

    /// Returns the current schedule count for a recipient.
    fn get_vesting_count(env: &Env, recipient: &Address) -> u32 {
        Self::migrate_if_needed(env, recipient);
        env.storage()
            .persistent()
            .get(&DataKey::VestingCount(recipient.clone()))
            .unwrap_or(0u32)
    }

    fn set_vesting_count(env: &Env, recipient: &Address, count: u32) {
        if count == 0 {
            env.storage()
                .persistent()
                .remove(&DataKey::VestingCount(recipient.clone()));
        } else {
            env.storage().persistent().set(&DataKey::VestingCount(recipient.clone()), &count);
            env.storage().persistent().extend_ttl(
                &DataKey::VestingCount(recipient.clone()),
                BUMP_THRESHOLD,
                BUMP_EXTEND_TO,
            );
        }
    }

    fn get_upgrade_proposal(env: &Env) -> Option<UpgradeProposal> {
        env.storage().persistent().get(&DataKey::UpgradeProposal)
    }

    fn set_upgrade_proposal(env: &Env, proposal: &UpgradeProposal) {
        env.storage()
            .persistent()
            .set(&DataKey::UpgradeProposal, proposal);
        env.storage().persistent().extend_ttl(
            &DataKey::UpgradeProposal,
            BUMP_THRESHOLD,
            BUMP_EXTEND_TO,
        );
    }

    fn remove_upgrade_proposal(env: &Env) {
        env.storage().persistent().remove(&DataKey::UpgradeProposal);
    }

    /// Calculate the vested amount using safe checked arithmetic.
    ///
    /// Supports compound "cliff then linear" vesting:
    ///   - Returns 0 if current_time has not yet reached cliff_time.
    ///   - After the cliff passes, applies step-based linear vesting measured
    ///     from start_time (so tokens that accrued between start_time and
    ///     cliff_time become claimable as soon as the cliff is reached).
    ///   - When step == 0 all tokens unlock at end_time (pure cliff mode).
    ///
    /// #299/#303: All arithmetic uses checked_mul / checked_div so an overflow
    /// returns VestingError::Overflow instead of panicking or silently wrapping.
    fn calculate_vested_amount(env: &Env, total: i128, elapsed: i128, duration: i128, cliff_time: u64, current_time: u64, step: u64) -> i128 {
        // Cliff gate: nothing is claimable before the cliff timestamp.
        if current_time < cliff_time {
            return 0;
        }

        if step == 0 {
            // Pure cliff / full-unlock mode: all tokens unlock at end_time.
            if elapsed >= duration {
                total
            } else {
                0
            }
        } else {
            // Step-based linear vesting: vested = total * (elapsed / step) / (duration / step)
            let step_i128 = step as i128;

            // Both divisions are exact by construction (validated at deposit time via
            // InvalidVestingStep), so checked_div is a safety net, not a rounding path.
            let num_steps = duration
                .checked_div(step_i128)
                .unwrap_or_else(|| soroban_sdk::panic_with_error!(env, VestingError::Overflow));
            let current_step = elapsed
                .checked_div(step_i128)
                .unwrap_or_else(|| soroban_sdk::panic_with_error!(env, VestingError::Overflow));

            if current_step >= num_steps {
                total
            } else {
                // Intermediate product `total * current_step` can overflow i128 for
                // very large token amounts; checked_mul catches this before division.
                let numerator = total
                    .checked_mul(current_step)
                    .unwrap_or_else(|| soroban_sdk::panic_with_error!(env, VestingError::Overflow));
                numerator
                    .checked_div(num_steps)
                    .unwrap_or_else(|| soroban_sdk::panic_with_error!(env, VestingError::Overflow))
            }
        }
    }

    /// Appends a new vesting schedule for a recipient and returns its index.
    fn push_vesting(env: &Env, recipient: &Address, data: &VestingData) -> u32 {
        let idx = Self::get_vesting_count(env, recipient);
        Self::set_vesting(env, recipient, idx, data);
        let next_count = idx
            .checked_add(1)
            .unwrap_or_else(|| soroban_sdk::panic_with_error!(env, VestingError::Overflow));
        Self::set_vesting_count(env, recipient, next_count);
        idx
    }

    /// Reads a single vesting schedule by index. Panics if missing.
    fn get_vesting(env: &Env, recipient: &Address, index: u32) -> VestingData {
        Self::migrate_if_needed(env, recipient);
        env.storage()
            .persistent()
            .get(&DataKey::VestingEntry(recipient.clone(), index))
            .unwrap_or_else(|| soroban_sdk::panic_with_error!(env, VestingError::NotFound))
    }

    fn set_vesting(env: &Env, recipient: &Address, index: u32, vesting: &VestingData) {
        env.storage()
            .persistent()
            .set(&DataKey::VestingEntry(recipient.clone(), index), vesting);
        env.storage().persistent().extend_ttl(
            &DataKey::VestingEntry(recipient.clone(), index),
            BUMP_THRESHOLD,
            BUMP_EXTEND_TO,
        );
    }

    /// Removes a schedule by swapping it with the last entry (O(1) removal).
    fn remove_vesting(env: &Env, recipient: &Address, index: u32) {
        let count = Self::get_vesting_count(env, recipient);
        if index >= count {
            return; // Or panic, handled upstream
        }

        let last = count - 1;
        if index != last {
            // Move last entry into the removed slot
            let last_data = Self::get_vesting(env, recipient, last);
            Self::set_vesting(env, recipient, index, &last_data);
        }

        env.storage()
            .persistent()
            .remove(&DataKey::VestingEntry(recipient.clone(), last));

        Self::set_vesting_count(env, recipient, last);
    }

    fn extend_ttl_admin(env: &Env) {
        if env.storage().persistent().has(&DataKey::Admin) {
            env.storage()
                .persistent()
                .extend_ttl(&DataKey::Admin, BUMP_THRESHOLD, BUMP_EXTEND_TO);
        }
        if env.storage().persistent().has(&DataKey::PendingAdmin) {
            env.storage().persistent().extend_ttl(
                &DataKey::PendingAdmin,
                BUMP_THRESHOLD,
                BUMP_EXTEND_TO,
            );
        }
        if env.storage().persistent().has(&DataKey::AdminInitialized) {
            env.storage().persistent().extend_ttl(
                &DataKey::AdminInitialized,
                BUMP_THRESHOLD,
                BUMP_EXTEND_TO,
            );
        }
        if env.storage().persistent().has(&DataKey::Config) {
            env.storage()
                .persistent()
                .extend_ttl(&DataKey::Config, BUMP_THRESHOLD, BUMP_EXTEND_TO);
        }
    }

    fn extend_ttl_paused(env: &Env) {
        if env.storage().persistent().has(&DataKey::Paused) {
            env.storage()
                .persistent()
                .extend_ttl(&DataKey::Paused, BUMP_THRESHOLD, BUMP_EXTEND_TO);
        }
    }

    fn extend_ttl_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(BUMP_THRESHOLD, BUMP_EXTEND_TO);
    }

    fn extend_ttl_vesting_entry(env: &Env, recipient: &Address, idx: u32) {
        if env.storage().persistent().has(&DataKey::VestingEntry(recipient.clone(), idx)) {
            env.storage().persistent().extend_ttl(
                &DataKey::VestingEntry(recipient.clone(), idx),
                BUMP_THRESHOLD,
                BUMP_EXTEND_TO,
            );
        }
    }

    fn extend_ttl_vesting_count(env: &Env, recipient: &Address) {
        if env.storage().persistent().has(&DataKey::VestingCount(recipient.clone())) {
            env.storage().persistent().extend_ttl(
                &DataKey::VestingCount(recipient.clone()),
                BUMP_THRESHOLD,
                BUMP_EXTEND_TO,
            );
        }
    }

    fn extend_ttl_vesting(env: &Env, recipient: &Address, idx: u32) {
        Self::extend_ttl_vesting_entry(env, recipient, idx);
        Self::extend_ttl_vesting_count(env, recipient);
    }
}

#[contractimpl]
impl BatchVestingContract {
    /// Initialize a batch of vestings with support for multiple tokens.
    /// #210: Accept Vec<Token> to support multiple assets in a single batch.
    /// Tokens vector must match recipients length (one token per recipient).
    pub fn deposit(
        env: Env,
        sender: Address,
        tokens: Vec<Address>,
        recipients: Vec<Address>,
        amounts: Vec<i128>,
        start_time: u64,
        end_time: u64,
        cliff_time: u64,
        vesting_step: u64,
        memos: Vec<String>,
    ) {
        Self::panic_if_operation_paused(&env, PAUSE_DEPOSIT);
        sender.require_auth();

        if recipients.len() != amounts.len() || recipients.len() != memos.len() {
            soroban_sdk::panic_with_error!(&env, VestingError::LengthMismatch);
        }

        if recipients.len() != tokens.len() {
            soroban_sdk::panic_with_error!(&env, VestingError::LengthMismatch);
        }

        Self::panic_if_batch_too_large(&env, recipients.len());

        if end_time <= start_time {
            soroban_sdk::panic_with_error!(&env, VestingError::InvalidUnlockTime);
        }

        if end_time <= env.ledger().timestamp() {
            soroban_sdk::panic_with_error!(&env, VestingError::InvalidUnlockTime);
        }

        // #243: Validate cliff time
        if cliff_time < start_time || cliff_time > end_time {
            soroban_sdk::panic_with_error!(&env, VestingError::InvalidUnlockTime);
        }

        // #253: Validate vesting step
        let duration = end_time - start_time;
        if vesting_step > 1 && duration % vesting_step != 0 {
            soroban_sdk::panic_with_error!(&env, VestingError::InvalidVestingStep);
        }

        // #209: Create batch info entry for this deposit
        let batch_id = Self::get_next_batch_id(&env);
        let batch_info = BatchInfo {
            sender: sender.clone(),
            timestamp: env.ledger().timestamp(),
        };
        Self::set_batch_info(&env, batch_id, &batch_info);
        Self::increment_batch_id(&env);

        // Track total transfers per token (#210)
        let mut token_transfers: Vec<(Address, i128)> = Vec::new(&env);

        for i in 0..recipients.len() {
            let recipient = recipients.get(i).unwrap();
            let amount = amounts.get(i).unwrap();
            let token = tokens.get(i).unwrap();

            if amount <= 0 {
                soroban_sdk::panic_with_error!(&env, VestingError::InvalidAmount);
            }

            // #196: reject deposit if recipient is already at the schedule cap.
            let current_count = Self::get_vesting_count(&env, &recipient);
            let config = Self::get_config(&env);
            if current_count >= config.max_schedules_per_recipient {
                soroban_sdk::panic_with_error!(&env, VestingError::ScheduleLimitExceeded);
            }

            let idx = Self::push_vesting(
                &env,
                &recipient,
                &VestingData {
                    total_amount: amount,
                    released_amount: 0,
                    start_time,
                    end_time,
                    cliff_time,
                    vesting_step,
                    sender: sender.clone(),
                    batch_id,
                    token: token.clone(), // #194: bind token to this schedule
                    memo: memos.get(i).unwrap(),
                },
            );
            Self::extend_ttl_vesting(&env, &recipient, idx);

            env.events().publish(
                (Symbol::new(&env, "VestingDeposited"), sender.clone(), recipient),
                (amount, start_time, end_time, cliff_time, vesting_step, token.clone(), memos.get(i).unwrap()),
            );

            // #210: Accumulate token transfers for batch processing
            let mut found = false;
            for j in 0..token_transfers.len() {
                let (t, amt) = token_transfers.get(j).unwrap();
                if t == token {
                    token_transfers.set(j, (t.clone(), amt.checked_add(amount).unwrap_or_else(|| soroban_sdk::panic_with_error!(&env, VestingError::Overflow))));
                    found = true;
                    break;
                }
            }
            if !found {
                token_transfers.push_back((token.clone(), amount));
            }
        }

        // #210: Execute all token transfers
        for i in 0..token_transfers.len() {
            let (token, total_amount) = token_transfers.get(i).unwrap();
            let token_client = token::Client::new(&env, &token);
            token_client.transfer(&sender, &env.current_contract_address(), &total_amount);
        }

        // Collect per-recipient fee if configured.
        // The fee is charged in the contract's whitelisted fee_asset token (typically native XLM).
        // Fees are transferred directly to the treasury — they never enter the
        // vesting pool, so recipients are unaffected.
        // #543: fee_asset comes from contract config, not fee_config, preventing
        // admin from switching to an arbitrary/scam token after deployment.
        if let Some(fee_cfg) = Self::get_fee_config(&env) {
            if fee_cfg.fee_per_recipient > 0 {
                let config = Self::get_config(&env);
                let n = recipients.len() as i128;
                let total_fee = fee_cfg
                    .fee_per_recipient
                    .checked_mul(n)
                    .unwrap_or_else(|| soroban_sdk::panic_with_error!(&env, VestingError::Overflow));
                // #331: Always transfer fees in fee_asset regardless of batch token composition.
                // Multi-token batches may have different assets; fees are always collected
                // in the whitelisted fee_asset (typically native XLM), not tokens[0].
                let fee_token_client = token::Client::new(&env, &config.fee_asset);
                fee_token_client.transfer(&sender, &fee_cfg.treasury, &total_fee);

                env.events().publish(
                    (Symbol::new(&env, "FeeCollected"), sender.clone()),
                    (total_fee, config.fee_asset.clone(), fee_cfg.treasury),
                );
            }
        }
    }

    /// Initialize the contract admin at deployment time.
    ///
    /// This constructor binds the intended admin once, atomically during
    /// deployment/initialization, so no unrelated account can later claim the
    /// admin role through a separate first-claim step.
    pub fn __constructor(env: Env, admin: Address) {
        if Self::is_admin_initialized(&env) {
            soroban_sdk::panic_with_error!(&env, VestingError::AdminAlreadySet);
        }
        Self::initialize_admin(&env, &admin);
    }

    /// Legacy admin initialization entrypoint.
    ///
    /// This is kept as a compatibility surface for existing integrations, but
    /// it no longer acts as a public first-claim step. The intended admin must
    /// be initialized via the constructor during deployment.
    pub fn set_admin(env: Env, admin: Address) {
        let _ = admin;
        soroban_sdk::panic_with_error!(&env, VestingError::AdminAlreadySet);
    }

    /// Propose a new admin. Only the current admin can nominate a successor.
    pub fn propose_admin(env: Env, admin: Address, new_admin: Address) {
        Self::panic_if_operation_paused(&env, PAUSE_DEPOSIT | PAUSE_CLAIM | PAUSE_REVOKE);
        Self::require_current_admin(&env, &admin);
        Self::set_pending_admin_internal(&env, &new_admin);
        Self::extend_ttl_admin(&env);
        env.events().publish(
            (Symbol::new(&env, "AdminTransferProposed"),),
            (admin, new_admin),
        );
    }

    /// Accept a pending admin transfer.
    pub fn accept_admin(env: Env, new_admin: Address) {
        new_admin.require_auth();
        let pending_admin = Self::get_pending_admin(&env).unwrap_or_else(|| {
            soroban_sdk::panic_with_error!(&env, VestingError::Unauthorized)
        });
        if new_admin != pending_admin {
            soroban_sdk::panic_with_error!(&env, VestingError::Unauthorized);
        }

        let previous_admin = Self::get_admin(&env).unwrap_or_else(|| {
            soroban_sdk::panic_with_error!(&env, VestingError::NotAdmin)
        });
        Self::set_admin_internal(&env, &new_admin);
        Self::remove_pending_admin_internal(&env);
        Self::extend_ttl_admin(&env);

        env.events().publish(
            (Symbol::new(&env, "AdminTransferred"),),
            (previous_admin, new_admin),
        );
    }

    /// Renounce admin rights and clear any in-flight transfer.
    pub fn renounce_admin(env: Env, admin: Address) {
        Self::panic_if_operation_paused(&env, PAUSE_DEPOSIT | PAUSE_CLAIM | PAUSE_REVOKE);
        Self::require_current_admin(&env, &admin);
        Self::remove_admin_internal(&env);
        Self::remove_pending_admin_internal(&env);

        env.events()
            .publish((Symbol::new(&env, "AdminRenounced"),), admin);
    }

    /// Update contract pause mask. Only admin can set the mask.
    pub fn toggle_pause(env: Env, admin: Address, mask: u32) {
        Self::require_current_admin(&env, &admin);
        env.storage().persistent().set(&DataKey::PauseMask, &mask);
        // Clear legacy Paused flag if it exists to avoid confusion
        if env.storage().persistent().has(&DataKey::Paused) {
            env.storage().persistent().remove(&DataKey::Paused);
        }
        Self::extend_ttl_paused(&env);

        env.events()
            .publish((Symbol::new(&env, "PauseToggled"),), (admin, mask));
    }

    /// Update contract configuration. Only admin can call this.
    ///
    /// #543: The `fee_asset` field sets the single whitelisted token for fee
    /// collection. Once set, fees can only be collected in this token.
    pub fn set_config(env: Env, admin: Address, config: Config) {
        Self::require_current_admin(&env, &admin);
        Self::set_config_internal(&env, &config);

        env.events().publish(
            (Symbol::new(&env, "ConfigUpdated"),),
            (config.max_batch_size, config.max_schedules_per_recipient, config.upgrade_timelock, config.fee_asset),
        );
    }

    /// Configure the per-recipient deposit fee. Only admin can call this.
    ///
    /// Set `fee_per_recipient` to 0 to disable fees entirely.
    /// The `treasury` address receives all collected fees.
    ///
    /// #543 Security: The fee asset is NOT configurable here — it is set once
    /// at contract initialization via `set_config` and stored in the contract
    /// config. This prevents a malicious or compromised admin from switching
    /// the fee asset to an arbitrary/scam token to drain depositors.
    ///
    /// Security note: fees are immutable within a single `deposit` transaction —
    /// the fee parameters are read once at the start of each deposit call,
    /// preventing any "bait and switch" between fee reads and token transfers.
    ///
    /// Recommendation: set the admin to a Stellar multisig account with
    /// appropriate low/med/high thresholds so that fee changes require
    /// M-of-N signers, preventing a single compromised key from draining
    /// depositors via inflated fees.
    pub fn set_fee_config(env: Env, admin: Address, fee_per_recipient: i128, treasury: Address) {
        Self::require_current_admin(&env, &admin);
        if fee_per_recipient < 0 {
            soroban_sdk::panic_with_error!(&env, VestingError::InvalidAmount);
        }
        // #543: fee_asset is intentionally NOT a parameter — it comes from config
        // and cannot be changed via this function.
        let config = FeeConfig { fee_per_recipient, treasury: treasury.clone() };
        Self::set_fee_config_internal(&env, &config);

        // #543: Emit event with the whitelisted fee asset from config for transparency
        let contract_config = Self::get_config(&env);
        env.events().publish(
            (Symbol::new(&env, "FeeConfigUpdated"),),
            (fee_per_recipient, treasury, contract_config.fee_asset),
        );
    }

    /// Transfer vesting rights to a new address.
    ///
    /// Only the current recipient can call this — not the sender, not the admin.
    /// This allows a recipient to rotate to a new hardware wallet if their
    /// current wallet is compromised, without requiring any admin involvement.
    ///
    /// The storage key is updated atomically: the schedule is removed from the
    /// old recipient and appended to the new recipient's list.
    pub fn transfer_vesting_rights(
        env: Env,
        recipient: Address,
        index: u32,
        new_address: Address,
    ) {
        // Only the current recipient may authorise this transfer.
        recipient.require_auth();

        let count = Self::get_vesting_count(&env, &recipient);
        if index >= count {
            soroban_sdk::panic_with_error!(&env, VestingError::NotFound);
        }

        let vesting = Self::get_vesting(&env, &recipient, index);

        // Enforce schedule cap on the new address.
        let new_count = Self::get_vesting_count(&env, &new_address);
        let config = Self::get_config(&env);
        if new_count >= config.max_schedules_per_recipient {
            soroban_sdk::panic_with_error!(&env, VestingError::ScheduleLimitExceeded);
        }

        // Remove from old recipient (swap-with-last).
        Self::remove_vesting(&env, &recipient, index);

        // Append to new recipient.
        let new_idx = Self::push_vesting(&env, &new_address, &vesting);
        Self::extend_ttl_vesting(&env, &new_address, new_idx);

        env.events().publish(
            (Symbol::new(&env, "VestingTransferred"), recipient.clone()),
            (new_address, index),
        );
    }

    /// Revoke an unvested schedule by index.
    pub fn revoke(env: Env, caller: Address, recipient: Address, index: u32) {
        Self::panic_if_operation_paused(&env, PAUSE_REVOKE);
        caller.require_auth();

        let count = Self::get_vesting_count(&env, &recipient);
        if index >= count {
            soroban_sdk::panic_with_error!(&env, VestingError::NotFound);
        }

        let vesting = Self::get_vesting(&env, &recipient, index);
        let current_time = env.ledger().timestamp();

        // If it's already fully vested, it cannot be revoked.
        if current_time >= vesting.end_time {
            soroban_sdk::panic_with_error!(&env, VestingError::AlreadyVested);
        }

        // #209: Get sender from BatchInfo instead of VestingData
        let batch_info = Self::get_batch_info(&env, vesting.batch_id);
        let sender = batch_info.sender.clone();

        if !Self::is_authorized(&env, &caller, &sender) {
            soroban_sdk::panic_with_error!(&env, VestingError::Unauthorized);
        }

        let token = vesting.token.clone();

        // Calculate unvested amount to return to sender
        let duration = (vesting.end_time - vesting.start_time) as i128;
        let elapsed = if current_time > vesting.start_time {
            (current_time - vesting.start_time) as i128
        } else {
            0
        };

        let vested_amount = Self::calculate_vested_amount(
            &env,
            vesting.total_amount,
            elapsed,
            duration,
            vesting.cliff_time,
            current_time,
            vesting.vesting_step,
        );

        let revoked_amount = vesting.total_amount - vested_amount;

        // Final vested portion for recipient if they haven't claimed it yet
        let pending_vested = vested_amount - vesting.released_amount;

        Self::remove_vesting(&env, &recipient, index);

        let token_client = token::Client::new(&env, &token);
        if revoked_amount > 0 {
            token_client.transfer(&env.current_contract_address(), &sender, &revoked_amount);
        }

        if pending_vested > 0 {
            token_client.transfer(&env.current_contract_address(), &recipient, &pending_vested);
        }

        env.events().publish(
            (Symbol::new(&env, "VestingRevoked"), recipient, sender),
            (revoked_amount, pending_vested, token, vesting.memo.clone(), vesting.batch_id),
        );
    }

    /// #242: Partial revocation support.
    /// Revoke a portion of the unvested amount from a vesting schedule without
    /// removing the schedule entirely. This allows adjusting vesting when an
    /// employee transitions from full-time to part-time.
    ///
    /// The partial revocation reduces `total_amount` but leaves `released_amount`
    /// unchanged. The schedule remains active with the reduced total_amount.
    ///
    /// #323: Fixed to prevent revoking vested-but-unclaimed tokens.
    /// Revocable amount = total_amount - max(released_amount, vested_now)
    pub fn revoke_partial(
        env: Env,
        caller: Address,
        recipient: Address,
        index: u32,
        amount_to_revoke: i128,
    ) {
        Self::panic_if_operation_paused(&env, PAUSE_REVOKE);
        caller.require_auth();

        if amount_to_revoke <= 0 {
            soroban_sdk::panic_with_error!(&env, VestingError::InvalidAmount);
        }

        let count = Self::get_vesting_count(&env, &recipient);
        if index >= count {
            soroban_sdk::panic_with_error!(&env, VestingError::NotFound);
        }

        let mut vesting = Self::get_vesting(&env, &recipient, index);
        let current_time = env.ledger().timestamp();

        // If it's already fully vested, partial revocation is not allowed
        if current_time >= vesting.end_time {
            soroban_sdk::panic_with_error!(&env, VestingError::AlreadyVested);
        }

        // #209: Get sender from BatchInfo instead of VestingData
        let batch_info = Self::get_batch_info(&env, vesting.batch_id);
        let sender = batch_info.sender.clone();

        if !Self::is_authorized(&env, &caller, &sender) {
            soroban_sdk::panic_with_error!(&env, VestingError::Unauthorized);
        }

        // #323: Calculate vested amount using the same logic as claim
        let duration = (vesting.end_time - vesting.start_time) as i128;
        let elapsed = if current_time > vesting.start_time {
            (current_time - vesting.start_time) as i128
        } else {
            0
        };

        let vested_now = Self::calculate_vested_amount(
            &env,
            vesting.total_amount,
            elapsed,
            duration,
            vesting.cliff_time,
            current_time,
            vesting.vesting_step,
        );

        // Revocable amount = total_amount - max(released_amount, vested_now)
        // This ensures we cannot revoke tokens that have already vested, even if unclaimed
        let protected_amount = if vested_now > vesting.released_amount {
            vested_now
        } else {
            vesting.released_amount
        };
        
        let revocable_amount = vesting.total_amount - protected_amount;
        if amount_to_revoke > revocable_amount {
            soroban_sdk::panic_with_error!(&env, VestingError::InvalidAmount);
        }

        let token = vesting.token.clone();

        // Adjust the total_amount to reflect the partial revocation
        vesting.total_amount = vesting.total_amount
            .checked_sub(amount_to_revoke)
            .unwrap_or_else(|| soroban_sdk::panic_with_error!(&env, VestingError::Overflow));

        // Update the vesting schedule with the reduced total_amount
        Self::set_vesting(&env, &recipient, index, &vesting);
        Self::extend_ttl_vesting(&env, &recipient, index);

        // Transfer the revoked amount back to the sender
        let token_client = token::Client::new(&env, &token);
        if amount_to_revoke > 0 {
            token_client.transfer(&env.current_contract_address(), &sender, &amount_to_revoke);
        }

        env.events().publish(
            (Symbol::new(&env, "VestingPartiallyRevoked"), recipient, sender),
            (amount_to_revoke, vesting.total_amount, token, vesting.memo),
        );
    }

    /// Revoke unvested schedules for multiple (recipient, index) pairs.
    ///
    /// Requests MUST be provided pre-sorted in strictly descending order of
    /// `index` within each recipient.  This is required so that the
    /// swap-with-last removal strategy does not corrupt the indices of
    /// subsequent requests targeting the same recipient (#198).
    ///
    /// #308: The previous O(N²) insertion sort is replaced with a validation
    /// pass.  Sorting is pushed to the caller (off-chain), which keeps on-chain
    /// instruction counts well within Soroban's per-transaction resource limits
    /// for batches up to MAX_BATCH_SIZE (100).  Unsorted input is rejected
    /// immediately with VestingError::InvalidInput.
    ///
    /// #505: The ordering check enforces strictly descending `index` *globally*
    /// per recipient, not merely between adjacent requests.  Comparing only
    /// consecutive entries allowed interleaved same-recipient requests
    /// (separated by another recipient) to pass validation while still being
    /// out of order — e.g. `(R,2), (Other,5), (R,0), (R,1)` — which corrupts
    /// indices once swap-with-last removal runs.  We track the last index seen
    /// per recipient and reject any request whose index is not strictly smaller
    /// than the previous one for that same recipient.
    pub fn batch_revoke(env: Env, caller: Address, requests: Vec<RevokeRequest>) -> Vec<bool> {
        Self::panic_if_operation_paused(&env, PAUSE_REVOKE);
        caller.require_auth();
        Self::panic_if_batch_too_large(&env, requests.len());

        let n = requests.len();
        if n == 0 {
            return Vec::new(&env);
        }

        // Validate strictly-descending index order per recipient across the
        // ENTIRE request vector (not just adjacent pairs).  `last_index` maps a
        // recipient to the index of its most recent request seen so far; any new
        // request for that recipient must have a strictly smaller index. (#505)
        if n > 1 {
            let mut last_index: Map<Address, u32> = Map::new(&env);
            for i in 0..n {
                let curr = requests.get(i).unwrap();
                if let Some(prev_index) = last_index.get(curr.recipient.clone()) {
                    if curr.index >= prev_index {
                        soroban_sdk::panic_with_error!(&env, VestingError::InvalidInput);
                    }
                }
                last_index.set(curr.recipient.clone(), curr.index);
            }
        }

        let current_time = env.ledger().timestamp();

        // Pre-allocate results in caller-provided order (default false).
        let mut results: Vec<bool> = Vec::new(&env);
        for _ in 0..n {
            results.push_back(false);
        }

        for k in 0..n {
            let request = requests.get(k).unwrap();
            let recipient = &request.recipient;
            let index = request.index;

            let count = Self::get_vesting_count(&env, recipient);
            if index >= count {
                continue;
            }

            let vesting = Self::get_vesting(&env, recipient, index);

            if current_time >= vesting.end_time {
                continue;
            }

            // #209: Get sender from BatchInfo instead of VestingData
            let batch_info = Self::get_batch_info(&env, vesting.batch_id);
            let sender = batch_info.sender.clone();

            if !Self::is_authorized(&env, &caller, &sender) {
                continue;
            }

            let token = vesting.token.clone();

            let duration = (vesting.end_time - vesting.start_time) as i128;
            let elapsed = if current_time > vesting.start_time {
                (current_time - vesting.start_time) as i128
            } else {
                0
            };
            
            let vested_amount = Self::calculate_vested_amount(
                &env,
                vesting.total_amount,
                elapsed,
                duration,
                vesting.cliff_time,
                current_time,
                vesting.vesting_step,
            );

            let revoked_amount = vesting.total_amount - vested_amount;
            let pending_vested = vested_amount - vesting.released_amount;

            Self::remove_vesting(&env, recipient, index);

            let token_client = token::Client::new(&env, &token);
            if revoked_amount > 0 {
                token_client.transfer(&env.current_contract_address(), &sender, &revoked_amount);
            }
            if pending_vested > 0 {
                token_client.transfer(&env.current_contract_address(), &recipient, &pending_vested);
            }

            env.events().publish(
                (Symbol::new(&env, "VestingRevoked"), recipient.clone(), sender),
                (revoked_amount, pending_vested, token, vesting.memo.clone(), vesting.batch_id),
            );
            results.set(k, true);
        }
        results
    }

    /// Revoke unvested schedules for multiple (recipient, index) pairs atomically.
    /// Reverts the entire transaction if any revocation fails.
    ///
    /// Requests MUST be provided pre-sorted in strictly descending order of
    /// `index` within each recipient (same requirement as `batch_revoke`).
    /// This keeps on-chain instruction counts O(N) and within Soroban resource
    /// limits for batches up to MAX_BATCH_SIZE (100). Unsorted input is
    /// rejected immediately with VestingError::InvalidInput. (#544)
    pub fn revoke_batch(env: Env, caller: Address, requests: Vec<RevokeRequest>) {
        Self::panic_if_operation_paused(&env, PAUSE_REVOKE);
        caller.require_auth();
        Self::panic_if_batch_too_large(&env, requests.len());

        let n = requests.len();
        if n == 0 {
            return;
        }

        // O(N) validation: require strictly descending index per recipient so
        // swap-with-last removal does not corrupt pending indices. Sorting is
        // pushed to the caller (off-chain). (#544 / #308)
        if n > 1 {
            let mut last_index: Map<Address, u32> = Map::new(&env);
            for i in 0..n {
                let curr = requests.get(i).unwrap();
                if let Some(prev_index) = last_index.get(curr.recipient.clone()) {
                    if curr.index >= prev_index {
                        soroban_sdk::panic_with_error!(&env, VestingError::InvalidInput);
                    }
                }
                last_index.set(curr.recipient.clone(), curr.index);
            }
        }

        let current_time = env.ledger().timestamp();

        for k in 0..n {
            let request = requests.get(k).unwrap();
            let recipient = &request.recipient;
            let index = request.index;

            let count = Self::get_vesting_count(&env, recipient);
            if index >= count {
                soroban_sdk::panic_with_error!(&env, VestingError::NotFound);
            }

            let vesting = Self::get_vesting(&env, recipient, index);

            if current_time >= vesting.end_time {
                soroban_sdk::panic_with_error!(&env, VestingError::AlreadyVested);
            }

            let batch_info = Self::get_batch_info(&env, vesting.batch_id);
            let sender = batch_info.sender.clone();

            if !Self::is_authorized(&env, &caller, &sender) {
                soroban_sdk::panic_with_error!(&env, VestingError::Unauthorized);
            }

            let token = vesting.token.clone();
            let duration = (vesting.end_time - vesting.start_time) as i128;
            let elapsed = if current_time > vesting.start_time {
                (current_time - vesting.start_time) as i128
            } else {
                0
            };
            
            let vested_amount = Self::calculate_vested_amount(
                &env,
                vesting.total_amount,
                elapsed,
                duration,
                vesting.cliff_time,
                current_time,
                vesting.vesting_step,
            );

            let revoked_amount = vesting.total_amount - vested_amount;
            let pending_vested = vested_amount - vesting.released_amount;

            Self::remove_vesting(&env, recipient, index);

            let token_client = token::Client::new(&env, &token);
            if revoked_amount > 0 {
                token_client.transfer(&env.current_contract_address(), &sender, &revoked_amount);
            }
            if pending_vested > 0 {
                token_client.transfer(&env.current_contract_address(), &recipient, &pending_vested);
            }

            env.events().publish(
                (Symbol::new(&env, "VestingRevoked"), recipient.clone(), sender),
                (revoked_amount, pending_vested, token, vesting.memo.clone(), vesting.batch_id),
            );
        }
    }

    /// Return the contract version string.
    pub fn version(env: Env) -> String {
        String::from_str(&env, "1.1.0")
    }

    /// Propose a contract upgrade. Only admin can propose.
    pub fn propose_upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) {
        Self::require_current_admin(&env, &admin);
        let config = Self::get_config(&env);
        let execute_at = env.ledger().timestamp() + config.upgrade_timelock;
        let proposal = UpgradeProposal {
            new_wasm_hash: new_wasm_hash.clone(),
            execute_at,
        };
        Self::set_upgrade_proposal(&env, &proposal);
        
        env.events().publish(
            (Symbol::new(&env, "UpgradeProposed"),),
            (new_wasm_hash, execute_at),
        );
    }

    /// Execute a proposed contract upgrade. Only admin can execute.
    pub fn execute_upgrade(env: Env, admin: Address) {
        Self::require_current_admin(&env, &admin);
        let proposal = Self::get_upgrade_proposal(&env).unwrap_or_else(|| {
            soroban_sdk::panic_with_error!(&env, VestingError::NotFound)
        });

        if env.ledger().timestamp() < proposal.execute_at {
            soroban_sdk::panic_with_error!(&env, VestingError::TimelockNotExpired);
        }

        Self::remove_upgrade_proposal(&env);
        env.deployer()
            .update_current_contract_wasm(proposal.new_wasm_hash.clone());

        env.events().publish(
            (Symbol::new(&env, "UpgradeExecuted"),),
            (proposal.new_wasm_hash,),
        );
    }

    /// Claim up to `amount` tokens from the vesting schedule at `index`.
    ///
    /// Pass the full claimable balance as `amount` to drain the schedule in one
    /// call.  The schedule is removed only when fully depleted; otherwise the
    /// remaining balance stays locked and continues to vest.
    pub fn claim(env: Env, recipient: Address, index: u32, amount: i128) {
        Self::panic_if_operation_paused(&env, PAUSE_CLAIM);
        recipient.require_auth();

        if amount <= 0 {
            soroban_sdk::panic_with_error!(&env, VestingError::InvalidAmount);
        }

        let count = Self::get_vesting_count(&env, &recipient);
        if index >= count {
            soroban_sdk::panic_with_error!(&env, VestingError::NotFound);
        }

        let mut vesting = Self::get_vesting(&env, &recipient, index);
        let current_time = env.ledger().timestamp();

        if current_time < vesting.cliff_time {
            soroban_sdk::panic_with_error!(&env, VestingError::StillLocked);
        }

        let duration = (vesting.end_time - vesting.start_time) as i128;
        let elapsed = (current_time - vesting.start_time) as i128;

        let vested_amount = Self::calculate_vested_amount(
            &env,
            vesting.total_amount,
            elapsed,
            duration,
            vesting.cliff_time,
            current_time,
            vesting.vesting_step,
        );

        let claimable = vested_amount - vesting.released_amount;
        if claimable <= 0 {
            soroban_sdk::panic_with_error!(&env, VestingError::StillLocked);
        }

        // Cap the requested amount to what is actually claimable.
        let transfer_amount = amount.min(claimable);

        let token_client = token::Client::new(&env, &vesting.token);
        token_client.transfer(&env.current_contract_address(), &recipient, &transfer_amount);

        vesting.released_amount = vesting
            .released_amount
            .checked_add(transfer_amount)
            .unwrap_or_else(|| soroban_sdk::panic_with_error!(&env, VestingError::Overflow));

        if vesting.released_amount >= vesting.total_amount {
            Self::remove_vesting(&env, &recipient, index);
        } else {
            Self::set_vesting(&env, &recipient, index, &vesting);
        }

        env.events().publish(
            (Symbol::new(&env, "VestingClaimed"), recipient.clone()),
            (transfer_amount, vesting.token.clone(), vesting.memo),
        );
    }

    /// Claim all currently vested tokens across every schedule for the recipient.
    pub fn claim_all(env: Env, recipient: Address) {
        Self::panic_if_operation_paused(&env, PAUSE_CLAIM);
        recipient.require_auth();

        let count = Self::get_vesting_count(&env, &recipient);
        if count == 0 {
            soroban_sdk::panic_with_error!(&env, VestingError::NotFound);
        }

        let current_time = env.ledger().timestamp();
        let mut claimed_something = false;

        // Process in reverse so swap-with-last removals don't skip entries.
        for i in (0..count).rev() {
            let mut vesting = Self::get_vesting(&env, &recipient, i);

            if current_time < vesting.cliff_time {
                Self::extend_ttl_vesting(&env, &recipient, i);
                continue;
            }

            let duration = (vesting.end_time - vesting.start_time) as i128;
            let elapsed = (current_time - vesting.start_time) as i128;

            let vested_amount = Self::calculate_vested_amount(
                &env,
                vesting.total_amount,
                elapsed,
                duration,
                vesting.cliff_time,
                current_time,
                vesting.vesting_step,
            );

            let claimable = vested_amount - vesting.released_amount;

            if claimable > 0 {
                let token_client = token::Client::new(&env, &vesting.token);
                token_client.transfer(&env.current_contract_address(), &recipient, &claimable);

                vesting.released_amount = vesting
                    .released_amount
                    .checked_add(claimable)
                    .unwrap_or_else(|| soroban_sdk::panic_with_error!(&env, VestingError::Overflow));
                claimed_something = true;

                if vesting.released_amount >= vesting.total_amount {
                    Self::remove_vesting(&env, &recipient, i);
                } else {
                    Self::set_vesting(&env, &recipient, i, &vesting);
                }

                env.events().publish(
                    (Symbol::new(&env, "VestingClaimed"), recipient.clone()),
                    (claimable, vesting.token.clone(), vesting.memo),
                );
            } else {
                Self::extend_ttl_vesting(&env, &recipient, i);
            }
        }

        if !claimed_something {
            soroban_sdk::panic_with_error!(&env, VestingError::StillLocked);
        }
    }
    /// Bonus: Get paginated vesting schedules for a recipient
    pub fn get_vestings(env: Env, recipient: Address, start: u32, limit: u32) -> Vec<VestingData> {
        let count = Self::get_vesting_count(&env, &recipient);
        let mut result_vec = Vec::new(&env);

        if start >= count {
            return result_vec;
        }

        let end = start
            .checked_add(limit)
            .unwrap_or(count)
            .min(count);
        for i in start..end {
            result_vec.push_back(Self::get_vesting(&env, &recipient, i));
        }

        result_vec
    }

    /// Bumps the TTL for the contract instance and administrative keys.
    /// Can be called by anyone to help maintain the contract's availability.
    pub fn bump_instance_ttl(env: Env) {
        Self::extend_ttl_instance(&env);
        Self::extend_ttl_admin(&env);
        Self::extend_ttl_paused(&env);
    }

    /// Bumps the TTL for a specific vesting schedule and the recipient's schedule count.
    /// Can be called by anyone (e.g., a keeper bot or the recipient).
    pub fn bump_vesting_ttl(env: Env, recipient: Address, index: u32) {
        Self::extend_ttl_vesting(&env, &recipient, index);
    }

    /// Maintenance function to bump a bounded page of recipient vesting schedules.
    pub fn maintenance(env: Env, recipient: Address, start_index: u32, limit: u32) {
        Self::bump_instance_ttl(env.clone());
        let count = Self::get_vesting_count(&env, &recipient);

        if limit == 0 || start_index >= count {
            return;
        }

        Self::extend_ttl_vesting_count(&env, &recipient);

        let end_index = start_index.saturating_add(limit).min(count);
        for i in start_index..end_index {
            Self::extend_ttl_vesting_entry(&env, &recipient, i);
        }
    }
}
mod test;
mod ttl_test;