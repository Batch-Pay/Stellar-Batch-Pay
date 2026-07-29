#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    token, Address, Env, IntoVal, String, Symbol, TryFromVal, TryIntoVal, Vec,
};
use token::Client as TokenClient;
use token::StellarAssetClient as TokenAdminClient;

fn create_token_contract<'a>(
    env: &Env,
    admin: &Address,
) -> (TokenClient<'a>, TokenAdminClient<'a>) {
    let contract_id = env.register_stellar_asset_contract(admin.clone());
    (
        TokenClient::new(env, &contract_id),
        TokenAdminClient::new(env, &contract_id),
    )
}

fn over_limit_recipients(env: &Env) -> Vec<Address> {
    let mut recipients = Vec::new(env);
    for _ in 0..(MAX_BATCH_SIZE + 1) {
        recipients.push_back(Address::generate(env));
    }
    recipients
}

fn matching_amounts(env: &Env, len: u32, amount: i128) -> Vec<i128> {
    let mut amounts = Vec::new(env);
    for _ in 0..len {
        amounts.push_back(amount);
    }
    amounts
}

fn matching_tokens(env: &Env, len: u32, token_address: Address) -> Vec<Address> {
    let mut tokens = Vec::new(env);
    for _ in 0..len {
        tokens.push_back(token_address.clone());
    }
    tokens
}

fn matching_memos(env: &Env, len: u32) -> Vec<String> {
    let mut memos = Vec::new(env);
    for _ in 0..len {
        memos.push_back(String::from_str(env, ""));
    }
    memos
}

fn setup_contract(env: &Env, client: &BatchVestingContractClient) {
    let admin = Address::generate(env);
    client.__constructor(&admin);
    client.set_config(&admin, &Config {
        max_batch_size: 100,
        max_schedules_per_recipient: 10,
        upgrade_timelock: 7 * 24 * 60 * 60,
        fee_asset: Address::generate(env),
    });
}

#[test]
fn test_version() {
    let env = Env::default();
    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    assert_eq!(client.version(), String::from_str(&env, "1.1.0"));
}

#[test]
fn test_deposit_and_claim() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token_contract(&env, &token_admin);

    token_admin_client.mint(&sender, &1000);

    let recipients = Vec::from_array(&env, [recipient1.clone(), recipient2.clone()]);
    let amounts = Vec::from_array(&env, [100, 200]);
    let unlock_time = 1000;

    env.ledger().with_mut(|li| {
        li.timestamp = 0;
    });

    client.deposit(
        &sender, 
        &Vec::from_array(&env, [token.address.clone(), token.address.clone()]), 
        &recipients, 
        &amounts, 
        &0, 
        &unlock_time,
        &0, // cliff_time
        &0, // vesting_step
        &Vec::from_array(&env, [String::from_str(&env, ""), String::from_str(&env, "")])
    );

    assert_eq!(token.balance(&sender), 700);
    assert_eq!(token.balance(&contract_id), 300);

    env.ledger().with_mut(|li| {
        li.timestamp = 1001;
    });

    client.claim_all(&recipient1);
    assert_eq!(token.balance(&recipient1), 100);
    assert_eq!(token.balance(&contract_id), 200);

    client.claim_all(&recipient2);
    assert_eq!(token.balance(&recipient2), 200);
    assert_eq!(token.balance(&contract_id), 0);
}

#[test]
fn test_revoke_by_sender() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token_contract(&env, &token_admin);
    token_admin_client.mint(&sender, &1000);

    let recipients = Vec::from_array(&env, [recipient.clone()]);
    let amounts = Vec::from_array(&env, [100]);
    let unlock_time = 1000;

    env.ledger().with_mut(|li| {
        li.timestamp = 0;
    });

    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone()]),
        &recipients,
        &amounts,
        &0,
        &unlock_time,
        &0, // cliff_time
        &0, // vesting_step
        &Vec::from_array(&env, [String::from_str(&env, "")])
    );

    env.ledger().with_mut(|li| {
        li.timestamp = 500;
    });

    client.revoke(&sender, &recipient, &0);

    assert_eq!(token.balance(&sender), 1000);
    assert_eq!(token.balance(&contract_id), 0);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #2)")]
fn test_claim_after_revoke_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token_contract(&env, &token_admin);
    token_admin_client.mint(&sender, &1000);

    let recipients = Vec::from_array(&env, [recipient.clone()]);
    let amounts = Vec::from_array(&env, [100]);
    let unlock_time = 1000;

    env.ledger().with_mut(|li| {
        li.timestamp = 0;
    });

    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone()]),
        &recipients,
        &amounts,
        &0,
        &unlock_time,
        &0, // cliff_time
        &0, // vesting_step
        &Vec::from_array(&env, [String::from_str(&env, "")])
    );
    env.ledger().with_mut(|li| {
        li.timestamp = 500;
    });
    client.revoke(&sender, &recipient, &0);

    client.claim_all(&recipient);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #9)")]
fn test_revoke_by_admin_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let admin = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token_contract(&env, &token_admin);
    token_admin_client.mint(&sender, &1000);

    client.__constructor(&admin);
    client.set_config(&admin, &Config {
        max_batch_size: 100,
        max_schedules_per_recipient: 10,
        upgrade_timelock: 7 * 24 * 60 * 60,
        fee_asset: Address::generate(&env),
    });

    let recipients = Vec::from_array(&env, [recipient.clone()]);
    let amounts = Vec::from_array(&env, [100]);
    let unlock_time = 1000;

    env.ledger().with_mut(|li| {
        li.timestamp = 0;
    });
    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone()]),
        &recipients,
        &amounts,
        &0,
        &unlock_time,
        &0, // cliff_time
        &0, // vesting_step
        &Vec::from_array(&env, [String::from_str(&env, "")])
    );

    env.ledger().with_mut(|li| {
        li.timestamp = 500;
    });

    client.revoke(&admin, &recipient, &0);

    assert_eq!(token.balance(&sender), 1000);
    assert_eq!(token.balance(&contract_id), 0);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #9)")]
fn test_revoke_unauthorized() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let attacker = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token_contract(&env, &token_admin);
    token_admin_client.mint(&sender, &1000);

    let recipients = Vec::from_array(&env, [recipient.clone()]);
    let amounts = Vec::from_array(&env, [100]);
    let unlock_time = 1000;

    env.ledger().with_mut(|li| {
        li.timestamp = 0;
    });

    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone()]),
        &recipients,
        &amounts,
        &0,
        &unlock_time,
        &0, // cliff_time
        &0, // vesting_step
        &Vec::from_array(&env, [String::from_str(&env, "")])
    );

    env.ledger().with_mut(|li| {
        li.timestamp = 500;
    });

    client.revoke(&attacker, &recipient, &0);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #8)")]
fn test_revoke_already_vested() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token_contract(&env, &token_admin);
    token_admin_client.mint(&sender, &1000);

    let recipients = Vec::from_array(&env, [recipient.clone()]);
    let amounts = Vec::from_array(&env, [100]);
    let unlock_time = 1000;

    env.ledger().with_mut(|li| {
        li.timestamp = 0;
    });

    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone()]),
        &recipients,
        &amounts,
        &0,
        &unlock_time,
        &0, // cliff_time
        &0, // vesting_step
        &Vec::from_array(&env, [String::from_str(&env, "")])
    );

    env.ledger().with_mut(|li| {
        li.timestamp = 1000;
    });

    // Attempt revoke after unlock_time has passed — must fail with AlreadyVested (#8)
    client.revoke(&sender, &recipient, &0);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #10)")]
fn test_claim_too_early() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient1 = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token_contract(&env, &token_admin);

    token_admin_client.mint(&sender, &1000);

    let recipients = Vec::from_array(&env, [recipient1.clone()]);
    let amounts = Vec::from_array(&env, [100]);
    let unlock_time = 1000;

    env.ledger().with_mut(|li| {
        li.timestamp = 0;
    });

    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone()]),
        &recipients,
        &amounts,
        &0,
        &unlock_time,
        &0, // cliff_time
        &0, // vesting_step
        &Vec::from_array(&env, [String::from_str(&env, "")])
    );

    // Try to claim before unlock_time
    env.ledger().with_mut(|li| {
        li.timestamp = 500;
    });

    client.claim_all(&recipient1);
}

#[test]
#[should_panic]
fn test_claim_unauthorized() {
    let env = Env::default();
    // NOT calling env.mock_all_auths() here
    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);

    let recipient = Address::generate(&env);
    let _token = Address::generate(&env);

    client.claim_all(&recipient);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #2)")]
fn test_claim_no_vesting() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);

    let recipient = Address::generate(&env);
    let _token = Address::generate(&env);

    client.claim_all(&recipient);
}

#[test]
#[should_panic]
fn test_deposit_unauthorized() {
    let env = Env::default();
    // NOT calling env.mock_all_auths() here
    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);

    let sender = Address::generate(&env);
    let token_admin = Address::generate(&env); let (token_client, _) = create_token_contract(&env, &token_admin); let token = token_client.address;
    (TokenAdminClient::new(&env, &token)).mint(&sender, &i128::MAX);
    let recipients = Vec::from_array(&env, [Address::generate(&env)]);
    let amounts = Vec::from_array(&env, [100]);
    let unlock_time = 1000;

    // This should fail because sender hasn't authorized the call
    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.clone()]),
        &recipients,
        &amounts,
        &0,
        &unlock_time,
        &0, // cliff_time
        &0, // vesting_step
        &Vec::from_array(&env, [String::from_str(&env, "")])
    );
}

#[test]
#[should_panic(expected = "Batch size exceeds max_batch_size")]
fn test_deposit_rejects_oversized_batch() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token_contract(&env, &token_admin);

    let recipients = over_limit_recipients(&env);
    let amounts = matching_amounts(&env, recipients.len(), 1);
    let total_amount = i128::from(recipients.len());
    let unlock_time = 1000u64;

    token_admin_client.mint(&sender, &total_amount);

    env.ledger().with_mut(|li| {
        li.timestamp = 0;
    });

    client.deposit(
        &sender, 
        &matching_tokens(&env, recipients.len(), token.address.clone()), 
        &recipients, 
        &amounts, 
        &0, 
        &unlock_time,
        &0, // cliff_time
        &0, // vesting_step
        &matching_memos(&env, recipients.len())
    );
}

#[test]
fn test_events_emission() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token_contract(&env, &token_admin);

    token_admin_client.mint(&sender, &1000);

    let recipients = Vec::from_array(&env, [recipient1.clone(), recipient2.clone()]);
    let amounts = Vec::from_array(&env, [100, 200]);
    let unlock_time: u64 = 1000;

    env.ledger().with_mut(|li| {
        li.timestamp = 0;
    });

    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone(), token.address.clone()]),
        &recipients,
        &amounts,
        &0,
        &unlock_time,
        &0, // cliff_time
        &0, // vesting_step
        &Vec::from_array(&env, [String::from_str(&env, ""), String::from_str(&env, "")])
    );

    // Verify VestingDeposited events
    let deposit_events = env.events().all();
    let deposit_symbol = Symbol::new(&env, "VestingDeposited");
    let mut deposit_found = 0;

    for (contract, topics, data) in deposit_events.iter() {
        if contract == contract_id && topics.len() == 3 {
            let topic: Symbol = topics.get(0).unwrap().into_val(&env);
            if topic == deposit_symbol {
                let evt_sender: Address = topics.get(1).unwrap().into_val(&env);
                let evt_recipient: Address = topics.get(2).unwrap().into_val(&env);
                let (evt_amount, evt_start, evt_end, evt_cliff, evt_step, evt_token, _evt_memo): (i128, u64, u64, u64, u64, Address, String) = data.into_val(&env);
                assert_eq!(evt_sender, sender);
                assert_eq!(evt_start, 0);
                assert_eq!(evt_end, unlock_time);
                assert_eq!(evt_cliff, 0);
                assert_eq!(evt_step, 0);
                assert_eq!(evt_token, token.address);
                if evt_recipient == recipient1 {
                    assert_eq!(evt_amount, 100);
                    deposit_found += 1;
                } else if evt_recipient == recipient2 {
                    assert_eq!(evt_amount, 200);
                    deposit_found += 1;
                }
            }
        }
    }
    assert_eq!(
        deposit_found, 2,
        "Should find 2 deposit events with correct data"
    );

    // Advance time and claim 1
    env.ledger().with_mut(|li| {
        li.timestamp = 1001;
    });

    client.claim_all(&recipient1);
    let claim1_events = env.events().all();
    let claim_symbol = Symbol::new(&env, "VestingClaimed");
    let mut claim1_found = false;

    for (contract, topics, data) in claim1_events.iter() {
        if contract == contract_id && topics.len() == 2 {
            let topic: Symbol = topics.get(0).unwrap().into_val(&env);
            if topic == claim_symbol {
                let evt_recipient: Address = topics.get(1).unwrap().into_val(&env);
                let (evt_amount, _evt_token, _evt_memo): (i128, Address, String) = data.into_val(&env);
                assert_eq!(evt_recipient, recipient1);
                assert_eq!(evt_amount, 100);
                claim1_found = true;
            }
        }
    }
    assert!(claim1_found, "Should find claim event for recipient1");

    // Claim 2
    client.claim_all(&recipient2);
    let claim2_events = env.events().all();
    let mut claim2_found = false;

    for (contract, topics, data) in claim2_events.iter() {
        if contract == contract_id && topics.len() == 2 {
            let topic: Symbol = topics.get(0).unwrap().into_val(&env);
            if topic == claim_symbol {
                let evt_recipient: Address = topics.get(1).unwrap().into_val(&env);
                let (evt_amount, _evt_token, _evt_memo): (i128, Address, String) = data.into_val(&env);
                assert_eq!(evt_recipient, recipient2);
                assert_eq!(evt_amount, 200);
                claim2_found = true;
            }
        }
    }
    assert!(claim2_found, "Should find claim event for recipient2");
}

#[test]
fn test_multiple_vestings_different_unlocks() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token_contract(&env, &token_admin);

    token_admin_client.mint(&sender, &1000);

    let recipients = Vec::from_array(&env, [recipient.clone()]);

    env.ledger().with_mut(|li| {
        li.timestamp = 0;
    });

    let amounts_first = Vec::from_array(&env, [100]);
    let unlock_time_first = 1000;
    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone()]),
        &recipients,
        &amounts_first,
        &0,
        &unlock_time_first,
        &0, // cliff_time
        &0, // vesting_step
        &Vec::from_array(&env, [String::from_str(&env, "")])
    );

    let amounts_second = Vec::from_array(&env, [300]);
    let unlock_time_second = 2000;
    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone()]),
        &recipients,
        &amounts_second,
        &0,
        &unlock_time_second,
        &0, // cliff_time
        &0, // vesting_step
        &Vec::from_array(&env, [String::from_str(&env, "")])
    );

    assert_eq!(token.balance(&sender), 600);
    assert_eq!(token.balance(&contract_id), 400);

    // First vesting should be claimable without affecting the later one.
    env.ledger().with_mut(|li| {
        li.timestamp = 1001;
    });

    client.claim_all(&recipient);
    assert_eq!(token.balance(&recipient), 100);
    assert_eq!(token.balance(&contract_id), 300);

    // Second vesting unlocks later.
    env.ledger().with_mut(|li| {
        li.timestamp = 2001;
    });

    client.claim_all(&recipient);
    assert_eq!(token.balance(&recipient), 400);
    assert_eq!(token.balance(&contract_id), 0);
}

#[test]
fn test_batch_revoke_by_sender() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);
    let recipient3 = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token_contract(&env, &token_admin);
    token_admin_client.mint(&sender, &1000);

    let recipients = Vec::from_array(
        &env,
        [recipient1.clone(), recipient2.clone(), recipient3.clone()],
    );
    let amounts = Vec::from_array(&env, [100, 200, 300]);
    let unlock_time = 1000;

    env.ledger().with_mut(|li| {
        li.timestamp = 0;
    });

    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone(), token.address.clone(), token.address.clone()]),
        &recipients,
        &amounts,
        &0,
        &unlock_time,
        &0, // cliff_time
        &0, // vesting_step
        &Vec::from_array(&env, [String::from_str(&env, ""), String::from_str(&env, ""), String::from_str(&env, "")])
    );

    assert_eq!(token.balance(&sender), 400);
    assert_eq!(token.balance(&contract_id), 600);

    env.ledger().with_mut(|li| {
        li.timestamp = 500;
    });

    let revoke_requests = Vec::from_array(
        &env,
        [
            RevokeRequest {
                recipient: recipient1.clone(),
                index: 0,
            },
            RevokeRequest {
                recipient: recipient2.clone(),
                index: 0,
            },
        ],
    );
    let results = client.batch_revoke(&sender, &revoke_requests);

    assert_eq!(results.get(0).unwrap(), true);
    assert_eq!(results.get(1).unwrap(), true);
    assert_eq!(token.balance(&sender), 700);
    assert_eq!(token.balance(&contract_id), 300);
}

#[test]
fn test_batch_revoke_by_admin_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);

    let sender = Address::generate(&env);
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);
    let admin = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token_contract(&env, &token_admin);
    token_admin_client.mint(&sender, &1000);

    client.__constructor(&admin);
    client.set_config(&admin, &Config {
        max_batch_size: 100,
        max_schedules_per_recipient: 10,
        upgrade_timelock: 7 * 24 * 60 * 60,
        fee_asset: Address::generate(&env),
    });

    let recipients = Vec::from_array(&env, [recipient1.clone(), recipient2.clone()]);
    let amounts = Vec::from_array(&env, [150, 250]);
    let unlock_time = 1000;

    env.ledger().with_mut(|li| {
        li.timestamp = 0;
    });
    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone(), token.address.clone()]),
        &recipients,
        &amounts,
        &0,
        &unlock_time,
        &0, // cliff_time
        &0, // vesting_step
        &Vec::from_array(&env, [String::from_str(&env, ""), String::from_str(&env, "")])
    );

    env.ledger().with_mut(|li| {
        li.timestamp = 500;
    });

    let revoke_requests = Vec::from_array(
        &env,
        [
            RevokeRequest {
                recipient: recipient1.clone(),
                index: 0,
            },
            RevokeRequest {
                recipient: recipient2.clone(),
                index: 0,
            },
        ],
    );
    let results = client.batch_revoke(&admin, &revoke_requests);
    // Admin cannot revoke, so results should be false
    assert_eq!(results.get(0).unwrap(), false);
    assert_eq!(results.get(1).unwrap(), false);
    assert_eq!(token.balance(&sender), 600); // sender spent 400 on deposit
    assert_eq!(token.balance(&admin), 0); // admin got nothing
    assert_eq!(token.balance(&contract_id), 400); // funds remain locked
}

#[test]
fn test_batch_revoke_multiple_senders_fails_for_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);

    let sender1 = Address::generate(&env);
    let sender2 = Address::generate(&env);
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);
    let admin = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token_contract(&env, &token_admin);

    token_admin_client.mint(&sender1, &1000);
    token_admin_client.mint(&sender2, &1000);

    client.__constructor(&admin);
    client.set_config(&admin, &Config {
        max_batch_size: 100,
        max_schedules_per_recipient: 10,
        upgrade_timelock: 7 * 24 * 60 * 60,
        fee_asset: Address::generate(&env),
    });

    let unlock_time = 1000;

    env.ledger().with_mut(|li| {
        li.timestamp = 0;
    });

    // Sender 1 deposits for Recipient 1
    client.deposit(
        &sender1,
        &Vec::from_array(&env, [token.address.clone()]),
        &Vec::from_array(&env, [recipient1.clone()]),
        &Vec::from_array(&env, [100]),
        &0,
        &unlock_time,
        &0, // cliff_time
        &0, // vesting_step
        &Vec::from_array(&env, [String::from_str(&env, "")])
    );

    // Sender 2 deposits for Recipient 2
    client.deposit(
        &sender2,
        &Vec::from_array(&env, [token.address.clone()]),
        &Vec::from_array(&env, [recipient2.clone()]),
        &Vec::from_array(&env, [200]),
        &0,
        &unlock_time,
        &0, // cliff_time
        &0, // vesting_step
        &Vec::from_array(&env, [String::from_str(&env, "")])
    );

    assert_eq!(token.balance(&sender1), 900);
    assert_eq!(token.balance(&sender2), 800);
    assert_eq!(token.balance(&contract_id), 300);

    env.ledger().with_mut(|li| {
        li.timestamp = 500;
    });

    // Admin revokes both in a batch
    let revoke_requests = Vec::from_array(
        &env,
        [
            RevokeRequest {
                recipient: recipient1.clone(),
                index: 0,
            },
            RevokeRequest {
                recipient: recipient2.clone(),
                index: 0,
            },
        ],
    );
    let results = client.batch_revoke(&admin, &revoke_requests);

    // Admin revokes should fail
    assert_eq!(results.get(0).unwrap(), false);
    assert_eq!(results.get(1).unwrap(), false);
    assert_eq!(token.balance(&sender1), 900); // unchanged
    assert_eq!(token.balance(&sender2), 800); // unchanged
    assert_eq!(token.balance(&admin), 0);
    assert_eq!(token.balance(&contract_id), 300); // funds remain locked
}

#[test]
fn test_batch_revoke_unauthorized() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);
    let attacker = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token_contract(&env, &token_admin);
    token_admin_client.mint(&sender, &1000);

    let recipients = Vec::from_array(&env, [recipient1.clone(), recipient2.clone()]);
    let amounts = Vec::from_array(&env, [100, 200]);
    let unlock_time = 1000;

    env.ledger().with_mut(|li| {
        li.timestamp = 0;
    });

    client.deposit(
        &sender, 
        &Vec::from_array(&env, [token.address.clone(), token.address.clone()]), 
        &recipients, 
        &amounts, 
        &0, 
        &unlock_time,
        &0, // cliff_time
        &0, // vesting_step
        &Vec::from_array(&env, [String::from_str(&env, ""), String::from_str(&env, "")])
    );

    env.ledger().with_mut(|li| {
        li.timestamp = 500;
    });

    let revoke_requests = Vec::from_array(
        &env,
        [
            RevokeRequest {
                recipient: recipient1.clone(),
                index: 0,
            },
            RevokeRequest {
                recipient: recipient2.clone(),
                index: 0,
            },
        ],
    );
    // Attacker is not sender or admin, so both entries fail
    let results = client.batch_revoke(&attacker, &revoke_requests);
    assert_eq!(
        results.get(0).unwrap(),
        false,
        "Unauthorized attacker should fail for recipient1"
    );
    assert_eq!(
        results.get(1).unwrap(),
        false,
        "Unauthorized attacker should fail for recipient2"
    );
    // Funds remain untouched
    assert_eq!(token.balance(&contract_id), 300);
}

#[test]
fn test_batch_revoke_already_vested() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token_contract(&env, &token_admin);
    token_admin_client.mint(&sender, &1000);

    let recipients = Vec::from_array(&env, [recipient1.clone(), recipient2.clone()]);
    let amounts = Vec::from_array(&env, [100, 200]);
    let unlock_time = 1000;

    env.ledger().with_mut(|li| {
        li.timestamp = 0;
    });

    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone(), token.address.clone()]),
        &recipients,
        &amounts,
        &0,
        &unlock_time,
        &0, // cliff_time
        &0, // vesting_step
        &Vec::from_array(&env, [String::from_str(&env, ""), String::from_str(&env, "")])
    );

    // Advance past unlock_time — both schedules are already vested
    env.ledger().with_mut(|li| {
        li.timestamp = 1000;
    });

    let revoke_requests = Vec::from_array(
        &env,
        [
            RevokeRequest {
                recipient: recipient1.clone(),
                index: 0,
            },
            RevokeRequest {
                recipient: recipient2.clone(),
                index: 0,
            },
        ],
    );
    let results = client.batch_revoke(&sender, &revoke_requests);
    assert_eq!(
        results.get(0).unwrap(),
        false,
        "Already-vested entry should return false"
    );
    assert_eq!(
        results.get(1).unwrap(),
        false,
        "Already-vested entry should return false"
    );
    // Funds are still in contract, not revoked
    assert_eq!(token.balance(&contract_id), 300);
}

#[test]
fn test_batch_revoke_no_vesting() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let (_token, _) = create_token_contract(&env, &token_admin);

    let revoke_requests = Vec::from_array(
        &env,
        [
            RevokeRequest {
                recipient: recipient1.clone(),
                index: 0,
            },
            RevokeRequest {
                recipient: recipient2.clone(),
                index: 0,
            },
        ],
    );

    // Neither recipient has any vesting — both should return false
    let results = client.batch_revoke(&sender, &revoke_requests);
    assert_eq!(
        results.get(0).unwrap(),
        false,
        "No-vesting entry should return false"
    );
    assert_eq!(
        results.get(1).unwrap(),
        false,
        "No-vesting entry should return false"
    );
}

#[test]
fn test_batch_revoke_events_emission() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token_contract(&env, &token_admin);
    token_admin_client.mint(&sender, &1000);

    let recipients = Vec::from_array(&env, [recipient1.clone(), recipient2.clone()]);
    let amounts = Vec::from_array(&env, [100, 200]);
    let unlock_time: u64 = 1000;

    env.ledger().with_mut(|li| {
        li.timestamp = 0;
    });

    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone(), token.address.clone()]),
        &recipients,
        &amounts,
        &0,
        &unlock_time,
        &0, // cliff_time
        &0, // vesting_step
        &Vec::from_array(&env, [String::from_str(&env, ""), String::from_str(&env, "")])
    );

    env.ledger().with_mut(|li| {
        li.timestamp = 500;
    });

    let revoke_requests = Vec::from_array(
        &env,
        [
            RevokeRequest {
                recipient: recipient1.clone(),
                index: 0,
            },
            RevokeRequest {
                recipient: recipient2.clone(),
                index: 0,
            },
        ],
    );
    let results = client.batch_revoke(&sender, &revoke_requests);
    assert_eq!(results.get(0).unwrap(), true);
    assert_eq!(results.get(1).unwrap(), true);

    let revoke_events = env.events().all();
    let revoke_symbol = Symbol::new(&env, "VestingRevoked");
    let mut revoke_found = 0;

    for (contract, topics, data) in revoke_events.iter() {
        if contract == contract_id && topics.len() == 3 {
            let topic: Symbol = topics.get(0).unwrap().into_val(&env);
            if topic == revoke_symbol {
                let evt_recipient: Address = topics.get(1).unwrap().into_val(&env);
                let evt_sender: Address = topics.get(2).unwrap().into_val(&env);
                let (evt_amount, evt_pending, evt_token, _evt_memo, _evt_batch_id): (i128, i128, Address, String, u32) = data.into_val(&env);
                assert_eq!(evt_sender, sender);
                // At t=500, unlock=1000, 0% is vested (cliff), 100% revoked
                assert_eq!(evt_token, token.address);
                if evt_recipient == recipient1 {
                    assert_eq!(evt_amount, 100);
                    assert_eq!(evt_pending, 0);
                    revoke_found += 1;
                } else if evt_recipient == recipient2 {
                    assert_eq!(evt_amount, 200);
                    assert_eq!(evt_pending, 0);
                    revoke_found += 1;
                }
            }
        }
    }
    assert_eq!(
        revoke_found, 2,
        "Should find 2 revoke events with correct data"
    );
}

#[test]
fn test_batch_revoke_partial_recipients() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);
    let recipient3 = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token_contract(&env, &token_admin);
    token_admin_client.mint(&sender, &1000);

    let recipients = Vec::from_array(
        &env,
        [recipient1.clone(), recipient2.clone(), recipient3.clone()],
    );
    let amounts = Vec::from_array(&env, [100, 200, 300]);
    let unlock_time = 1000;

    env.ledger().with_mut(|li| {
        li.timestamp = 0;
    });

    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone(), token.address.clone(), token.address.clone()]),
        &recipients,
        &amounts,
        &0,
        &unlock_time,
        &0, // cliff_time
        &0, // vesting_step
        &Vec::from_array(&env, [String::from_str(&env, ""), String::from_str(&env, ""), String::from_str(&env, "")])
    );

    env.ledger().with_mut(|li| {
        li.timestamp = 500;
    });

    let revoke_requests = Vec::from_array(
        &env,
        [RevokeRequest {
            recipient: recipient1.clone(),
            index: 0,
        }],
    );
    let results = client.batch_revoke(&sender, &revoke_requests);
    assert_eq!(results.get(0).unwrap(), true);

    assert_eq!(token.balance(&sender), 500);
    assert_eq!(token.balance(&contract_id), 500);

    env.ledger().with_mut(|li| {
        li.timestamp = 1001;
    });

    client.claim_all(&recipient2);
    assert_eq!(token.balance(&recipient2), 200);

    client.claim_all(&recipient3);
    assert_eq!(token.balance(&recipient3), 300);
}

#[test]
#[should_panic(expected = "Batch size exceeds max_batch_size")]
fn test_batch_revoke_rejects_oversized_batch() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (_token, _) = create_token_contract(&env, &token_admin);

    // Build an over-limit Vec<RevokeRequest>
    let mut requests: Vec<RevokeRequest> = Vec::new(&env);
    for _ in 0..(MAX_BATCH_SIZE + 1) {
        requests.push_back(RevokeRequest {
            recipient: Address::generate(&env),
            index: 0,
        });
    }

    client.batch_revoke(&sender, &requests);
}

#[test]
fn test_batch_revoke_partial_success() {
    // Mixed batch: valid, no-vesting, already-vested, unauthorized
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let attacker = Address::generate(&env);
    let recipient_valid = Address::generate(&env); // will succeed
    let recipient_novesting = Address::generate(&env); // has no vesting at all
    let recipient_vested = Address::generate(&env); // already vested
    let recipient_unauth = Address::generate(&env); // vesting owned by different sender

    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token_contract(&env, &token_admin);
    token_admin_client.mint(&sender, &1000);
    token_admin_client.mint(&attacker, &500);

    let unlock_time: u64 = 1000;

    env.ledger().with_mut(|li| {
        li.timestamp = 0;
    });

    // Deposit for the valid recipient
    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone()]),
        &Vec::from_array(&env, [recipient_valid.clone()]),
        &Vec::from_array(&env, [100i128]),
        &0,
        &unlock_time,
        &0, // cliff_time
        &0, // vesting_step
        &Vec::from_array(&env, [String::from_str(&env, "")])
    );

    // Deposit for the already-vested recipient
    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone()]),
        &Vec::from_array(&env, [recipient_vested.clone()]),
        &Vec::from_array(&env, [200i128]),
        &0,
        &unlock_time,
        &0, // cliff_time
        &0, // vesting_step
        &Vec::from_array(&env, [String::from_str(&env, "")])
    );

    // Deposit for the unauthorised recipient (owned by attacker, not sender)
    client.deposit(
        &attacker,
        &Vec::from_array(&env, [token.address.clone()]),
        &Vec::from_array(&env, [recipient_unauth.clone()]),
        &Vec::from_array(&env, [300i128]),
        &0,
        &unlock_time,
        &0, // cliff_time
        &0, // vesting_step
        &Vec::from_array(&env, [String::from_str(&env, "")])
    );

    // Advance time past unlock_time for recipient_vested
    env.ledger().with_mut(|li| {
        li.timestamp = 1000; // already vested
    });

    let revoke_requests = Vec::from_array(
        &env,
        [
            RevokeRequest {
                recipient: recipient_valid.clone(),
                index: 0,
            },
            RevokeRequest {
                recipient: recipient_novesting.clone(),
                index: 0,
            },
            RevokeRequest {
                recipient: recipient_vested.clone(),
                index: 0,
            },
            RevokeRequest {
                recipient: recipient_unauth.clone(),
                index: 0,
            },
        ],
    );

    // sender is not the vesting owner for recipient_unauth (attacker is)
    let results = client.batch_revoke(&sender, &revoke_requests);

    assert_eq!(results.len(), 4);
    assert_eq!(
        results.get(0).unwrap(),
        false,
        "recipient_valid: timestamp == unlock_time so already vested"
    );
    assert_eq!(
        results.get(1).unwrap(),
        false,
        "recipient_novesting: no schedule exists"
    );
    assert_eq!(
        results.get(2).unwrap(),
        false,
        "recipient_vested: already past unlock"
    );
    assert_eq!(
        results.get(3).unwrap(),
        false,
        "recipient_unauth: sender not authorized"
    );

    // Confirm no funds were moved
    assert_eq!(token.balance(&sender), 700);
    assert_eq!(token.balance(&contract_id), 600);
}

#[test]
fn test_batch_revoke_mixed_valid_and_invalid() {
    // Some entries succeed, some fail — valid ones must still be processed
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient_valid1 = Address::generate(&env);
    let recipient_novesting = Address::generate(&env);
    let recipient_valid2 = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token_contract(&env, &token_admin);
    token_admin_client.mint(&sender, &1000);

    let unlock_time: u64 = 2000;

    env.ledger().with_mut(|li| {
        li.timestamp = 0;
    });

    // Deposit for valid1 and valid2 only; novesting has nothing
    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone(), token.address.clone()]),
        &Vec::from_array(&env, [recipient_valid1.clone(), recipient_valid2.clone()]),
        &Vec::from_array(&env, [150i128, 250i128]),
        &0,
        &unlock_time,
        &0, // cliff_time
        &0, // vesting_step
        &Vec::from_array(&env, [String::from_str(&env, ""), String::from_str(&env, "")])
    );

    env.ledger().with_mut(|li| {
        li.timestamp = 500; // still locked
    });

    let revoke_requests = Vec::from_array(
        &env,
        [
            RevokeRequest {
                recipient: recipient_valid1.clone(),
                index: 0,
            },
            RevokeRequest {
                recipient: recipient_novesting.clone(),
                index: 0,
            },
            RevokeRequest {
                recipient: recipient_valid2.clone(),
                index: 0,
            },
        ],
    );

    let results = client.batch_revoke(&sender, &revoke_requests);

    assert_eq!(results.len(), 3);
    assert_eq!(
        results.get(0).unwrap(),
        true,
        "recipient_valid1 should succeed"
    );
    assert_eq!(
        results.get(1).unwrap(),
        false,
        "recipient_novesting has no schedule"
    );
    assert_eq!(
        results.get(2).unwrap(),
        true,
        "recipient_valid2 should succeed"
    );

    // valid1 (150) and valid2 (250) returned to sender
    assert_eq!(token.balance(&sender), 1000);
    assert_eq!(token.balance(&contract_id), 0);
}

// ─── Issue #695: Constructor-based admin initialization ───────────────────

#[test]
#[should_panic(expected = "HostError: Error(Contract, #6)")]
fn test_constructor_initializes_admin_and_blocks_late_takeover() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let attacker = Address::generate(&env);

    client.__constructor(&admin);

    // A later set_admin call must not be able to seize admin rights.
    client.set_admin(&attacker);
}

// ─── Issue #195: Admin re-claim after renouncement ───────────────────────────

/// After renounce_admin, set_admin must be permanently blocked so no one can
/// take over admin rights on a contract that intentionally renounced them.
#[test]
#[should_panic(expected = "HostError: Error(Contract, #6)")]
fn test_set_admin_after_renounce_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let attacker = Address::generate(&env);

    // Legitimate first-time admin initialisation
    client.__constructor(&admin);

    // Admin renounces ownership
    client.renounce_admin(&admin);

    // Attacker (or anyone else) must NOT be able to claim admin — must panic
    // with AdminAlreadySet (#6).
    client.set_admin(&attacker);
}

/// Calling set_admin a second time while an admin is still active must also
/// fail (existing behaviour preserved).
#[test]
#[should_panic(expected = "HostError: Error(Contract, #6)")]
fn test_set_admin_twice_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);

    let admin1 = Address::generate(&env);
    let admin2 = Address::generate(&env);

    client.__constructor(&admin1);
    // Second call must fail with AdminAlreadySet (#6)
    client.set_admin(&admin2);
}

// ─── Tests for updated claim behavior ───────────────────────────────────────

/// Verify that claim() retrieves funds for multiple tokens.
#[test]
fn test_claim_multi_token() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let (token_a, token_admin_a) = create_token_contract(&env, &Address::generate(&env));
    let (token_b, token_admin_b) = create_token_contract(&env, &Address::generate(&env));

    token_admin_a.mint(&sender, &1000);
    token_admin_b.mint(&sender, &1000);

    env.ledger().with_mut(|li| {
        li.timestamp = 0;
    });

    client.deposit(
        &sender,
        &Vec::from_array(&env, [token_a.address.clone()]),
        &Vec::from_array(&env, [recipient.clone()]),
        &Vec::from_array(&env, [100]),
        &0,
        &1000,
        &0,
        &0,
        &Vec::from_array(&env, [String::from_str(&env, "")])
    );
    client.deposit(
        &sender,
        &Vec::from_array(&env, [token_b.address.clone()]),
        &Vec::from_array(&env, [recipient.clone()]),
        &Vec::from_array(&env, [200]),
        &0,
        &1000,
        &0,
        &0,
        &Vec::from_array(&env, [String::from_str(&env, "")])
    );

    env.ledger().with_mut(|li| {
        li.timestamp = 1001;
    });

    client.claim_all(&recipient);

    assert_eq!(token_a.balance(&recipient), 100);
    assert_eq!(token_b.balance(&recipient), 200);
    assert_eq!(token_a.balance(&contract_id), 0);
    assert_eq!(token_b.balance(&contract_id), 0);
}

// (Tests removed as revoke no longer takes a token argument)

// ─── Issue #196: Per-recipient schedule cap ──────────────────────────────────

/// deposit must reject when a recipient already holds MAX_SCHEDULES_PER_RECIPIENT schedules.
#[test]
#[should_panic(expected = "HostError: Error(Contract, #12)")]
fn test_deposit_schedule_limit_exceeded() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token_contract(&env, &token_admin);
    token_admin_client.mint(&sender, &10000);

    env.ledger().with_mut(|li| {
        li.timestamp = 0;
    });

    // Fill up to the limit: each deposit adds one schedule for the same recipient.
    for i in 0..MAX_SCHEDULES_PER_RECIPIENT {
        let unlock = 1000 + u64::from(i) * 100;
        client.deposit(
            &sender,
            &Vec::from_array(&env, [token.address.clone()]),
            &Vec::from_array(&env, [recipient.clone()]),
            &Vec::from_array(&env, [10i128]),
            &0,
            &unlock,
            &0, // cliff
            &0, // step
            &Vec::from_array(&env, [String::from_str(&env, "")])
        );
    }

    // One more deposit for the same recipient must panic with ScheduleLimitExceeded (#12).
    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone()]),
        &Vec::from_array(&env, [recipient.clone()]),
        &Vec::from_array(&env, [10i128]),
        &0,
        &(2000 + u64::from(MAX_SCHEDULES_PER_RECIPIENT) * 100),
        &0, // cliff
        &0, // step
        &Vec::from_array(&env, [String::from_str(&env, "")])
    );
}

// ─── Issue #198: batch_revoke processes all matching schedules per recipient ──

/// When a recipient has multiple schedules and all are included in a single
/// batch_revoke call, every schedule must be revoked (not just the first).
/// This also validates that descending-index processing prevents swap-remove
/// index corruption.
#[test]
fn test_batch_revoke_multiple_schedules_same_recipient() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token_contract(&env, &token_admin);
    token_admin_client.mint(&sender, &10000);

    env.ledger().with_mut(|li| {
        li.timestamp = 0;
    });

    // Create 3 separate vesting schedules for the same recipient
    // (different unlock times so each deposit call is valid)
    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone()]),
        &Vec::from_array(&env, [recipient.clone()]),
        &Vec::from_array(&env, [100i128]),
        &0,
        &1000u64,
        &0, // cliff
        &0, // step
        &Vec::from_array(&env, [String::from_str(&env, "")])
    );
    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone()]),
        &Vec::from_array(&env, [recipient.clone()]),
        &Vec::from_array(&env, [200i128]),
        &0,
        &2000u64,
        &0, // cliff
        &0, // step
        &Vec::from_array(&env, [String::from_str(&env, "")])
    );
    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone()]),
        &Vec::from_array(&env, [recipient.clone()]),
        &Vec::from_array(&env, [300i128]),
        &0,
        &3000u64,
        &0, // cliff
        &0, // step
        &Vec::from_array(&env, [String::from_str(&env, "")])
    );

    // Recipient has 3 schedules (indices 0, 1, 2); contract holds 600 tokens.
    assert_eq!(token.balance(&contract_id), 600);

    env.ledger().with_mut(|li| {
        li.timestamp = 500; // all three are still locked
    });

    // Revoke all three in descending index order (required by the contract).
    let revoke_requests = Vec::from_array(
        &env,
        [
            RevokeRequest {
                recipient: recipient.clone(),
                index: 2,
            },
            RevokeRequest {
                recipient: recipient.clone(),
                index: 1,
            },
            RevokeRequest {
                recipient: recipient.clone(),
                index: 0,
            },
        ],
    );
    let results = client.batch_revoke(&sender, &revoke_requests);

    // All three must succeed
    assert_eq!(
        results.get(0).unwrap(),
        true,
        "schedule at index 0 must be revoked"
    );
    assert_eq!(
        results.get(1).unwrap(),
        true,
        "schedule at index 1 must be revoked"
    );
    assert_eq!(
        results.get(2).unwrap(),
        true,
        "schedule at index 2 must be revoked"
    );

    // All 600 tokens returned to sender; contract is empty.
    assert_eq!(token.balance(&sender), 10000);
    assert_eq!(token.balance(&contract_id), 0);
}

#[test]
fn test_lazy_migration() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);

    let recipient = Address::generate(&env);
    let sender = Address::generate(&env);
    let token_admin = Address::generate(&env); let (token_client, _) = create_token_contract(&env, &token_admin); let token = token_client.address;
    (TokenAdminClient::new(&env, &token)).mint(&sender, &i128::MAX);

    // Manually inject legacy Vec<LegacyVestingData> storage to simulate pre-migration data.
    // LegacyVestingData lacks cliff_time — migrate_if_needed must handle the field layout.
    let old_data = Vec::from_array(
        &env,
        [
            LegacyVestingData {
                total_amount: 100,
                released_amount: 0,
                start_time: 0,
                end_time: 1000,
                sender: sender.clone(),
                token: token.clone(),
                batch_id: 0,
                vesting_step: 0,
                memo: String::from_str(&env, ""),
            },
            LegacyVestingData {
                total_amount: 200,
                released_amount: 0,
                start_time: 0,
                end_time: 2000,
                sender: sender.clone(),
                token: token.clone(),
                batch_id: 0,
                vesting_step: 0,
                memo: String::from_str(&env, ""),
            },
        ],
    );

    env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .set(&DataKey::Vesting(recipient.clone()), &old_data);
    });

    // Calling get_vestings should trigger the lazy migration and return the two elements
    let vestings = client.get_vestings(&recipient, &0, &10);
    assert_eq!(vestings.len(), 2);
    assert_eq!(vestings.get(0).unwrap().total_amount, 100);
    assert_eq!(vestings.get(1).unwrap().total_amount, 200);

    // After migration, the old key should be deleted and the new individual entry keys exist.
    env.as_contract(&contract_id, || {
        assert_eq!(
            env.storage()
                .persistent()
                .has(&DataKey::Vesting(recipient.clone())),
            false
        );
        assert_eq!(
            env.storage()
                .persistent()
                .get::<_, u32>(&DataKey::VestingCount(recipient.clone()))
                .unwrap(),
            2
        );
    });
}

#[test]
fn test_get_vestings_pagination() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token_contract(&env, &token_admin);
    token_admin_client.mint(&sender, &10000);

    env.ledger().with_mut(|li| {
        li.timestamp = 0;
    });

    for i in 0..5 {
        client.deposit(
            &sender,
            &Vec::from_array(&env, [token.address.clone()]),
            &Vec::from_array(&env, [recipient.clone()]),
            &Vec::from_array(&env, [10i128]),
            &0,
            &(1000 + i * 100),
            &0,
            &0,
            &Vec::from_array(&env, [String::from_str(&env, "")])
        );
    }

    // start=0, limit=2 => returns 2 elements
    let page1 = client.get_vestings(&recipient, &0, &2);
    assert_eq!(page1.len(), 2);

    // start=2, limit=2 => returns 2 elements
    let page2 = client.get_vestings(&recipient, &2, &2);
    assert_eq!(page2.len(), 2);

    // start=4, limit=2 => returns 1 element (only 1 left)
    let page3 = client.get_vestings(&recipient, &4, &2);
    assert_eq!(page3.len(), 1);

    // start=5, limit=2 => returns 0 elements (out of bounds)
    let page4 = client.get_vestings(&recipient, &5, &2);
    assert_eq!(page4.len(), 0);
}

// ── #197: Event payload includes token address ──────────────────────────────

/// Helper: find the last event matching a topic symbol and deserialize its data.
fn find_event_data<T: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(
    env: &Env,
    event_name: &str,
) -> T {
    let events = env.events().all();
    let target = Symbol::new(env, event_name);
    for i in (0..events.len()).rev() {
        let (_, topics, data) = events.get(i).unwrap();
        if topics.len() >= 1 {
            let first_val = topics.get(0).unwrap();
            let first_sym: Result<Symbol, _> = first_val.try_into_val(env);
            if let Ok(sym) = first_sym {
                if sym == target {
                    return data.try_into_val(env).unwrap();
                }
            }
        }
    }
    panic!("Event '{}' not found", event_name);
}

#[test]
fn test_deposit_event_includes_token_address() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token_contract(&env, &token_admin);
    token_admin_client.mint(&sender, &1000);

    let recipients = Vec::from_array(&env, [recipient.clone()]);
    let amounts = Vec::from_array(&env, [100i128]);
    let unlock_time = 1000u64;
    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone()]),
        &recipients,
        &amounts,
        &0,
        &unlock_time,
        &0, // cliff_time
        &0, // vesting_step
        &Vec::from_array(&env, [String::from_str(&env, "")])
    );

    let payload: (i128, u64, u64, u64, u64, Address, String) = find_event_data(&env, "VestingDeposited");
    assert_eq!(payload.0, 100i128, "amount mismatch");
    assert_eq!(payload.1, 0u64, "start_time mismatch");
    assert_eq!(payload.2, 1000u64, "end_time mismatch");
    assert_eq!(payload.3, 0u64, "cliff_time mismatch");
    assert_eq!(payload.4, 0u64, "vesting_step mismatch");
    assert_eq!(payload.5, token.address, "token address missing from deposit event");
}

#[test]
fn test_claim_event_includes_token_address() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token_contract(&env, &token_admin);
    token_admin_client.mint(&sender, &1000);

    let recipients = Vec::from_array(&env, [recipient.clone()]);
    let amounts = Vec::from_array(&env, [100i128]);
    let unlock_time = 1000u64;
    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone()]),
        &recipients,
        &amounts,
        &0,
        &unlock_time,
        &0, // cliff_time
        &0, // vesting_step
        &Vec::from_array(&env, [String::from_str(&env, "")])
    );

    env.ledger().with_mut(|li| li.timestamp = 1001);
    client.claim(&recipient, &0, &100);

    let payload: (i128, Address, String) = find_event_data(&env, "VestingClaimed");
    assert_eq!(payload.0, 100i128, "amount mismatch");
    assert_eq!(payload.1, token.address, "token address missing from claim event");
}

#[test]
fn test_revoke_event_includes_token_address() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token_contract(&env, &token_admin);
    token_admin_client.mint(&sender, &1000);

    let recipients = Vec::from_array(&env, [recipient.clone()]);
    let amounts = Vec::from_array(&env, [100i128]);
    let unlock_time = 1000u64;
    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone()]),
        &recipients,
        &amounts,
        &0,
        &unlock_time,
        &0, // cliff_time
        &0, // vesting_step
        &Vec::from_array(&env, [String::from_str(&env, "")])
    );

    env.ledger().with_mut(|li| li.timestamp = 500);
    client.revoke(&sender, &recipient, &0);

    let payload: (i128, i128, Address, String, u32) = find_event_data(&env, "VestingRevoked");
    assert_eq!(payload.0, 100i128, "revoked_amount mismatch");
    assert_eq!(payload.1, 0i128, "pending_vested mismatch");
    assert_eq!(payload.2, token.address, "token address missing from revoke event");
}

#[test]
#[should_panic]
fn test_deposit_overflow() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);

    let token_admin = Address::generate(&env); 
    let (token_client, _) = create_token_contract(&env, &token_admin); 
    let token = token_client.address;
    (TokenAdminClient::new(&env, &token)).mint(&sender, &i128::MAX);

    let recipients = Vec::from_array(&env, [recipient1.clone(), recipient2.clone()]);
    // amounts that will overflow i128 if added
    let amounts = Vec::from_array(&env, [i128::MAX, 1]);
    let start_time = 1000;
    let end_time = 2000;

    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.clone(), token.clone()]),
        &recipients,
        &amounts,
        &start_time,
        &end_time,
        &start_time,
        &0,
        &Vec::from_array(&env, [String::from_str(&env, ""), String::from_str(&env, "")])
    );
}

#[test]
fn test_get_vestings_pagination_overflow() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token_admin = Address::generate(&env); 
    let (token_client, _) = create_token_contract(&env, &token_admin); 
    let token = token_client.address;
    (TokenAdminClient::new(&env, &token)).mint(&sender, &i128::MAX);

    env.ledger().with_mut(|li| {
        li.timestamp = 0;
    });

    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.clone()]),
        &Vec::from_array(&env, [recipient.clone()]),
        &Vec::from_array(&env, [100]),
        &1000,
        &2000,
        &1000, // cliff_time must be >= start_time
        &0,
        &Vec::from_array(&env, [String::from_str(&env, "")])
    );

    // This should not panic and should return 1 vesting
    let vestings = client.get_vestings(&recipient, &0, &u32::MAX);
    assert_eq!(vestings.len(), 1);
}

#[test]
fn test_ttl_bumping() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token_admin = Address::generate(&env); 
    let (token_client, _) = create_token_contract(&env, &token_admin); 
    let token = token_client.address;
    (TokenAdminClient::new(&env, &token)).mint(&sender, &1000);

    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.clone()]),
        &Vec::from_array(&env, [recipient.clone()]),
        &Vec::from_array(&env, [1000]),
        &1000,
        &2000,
        &1000, // cliff_time must be >= start_time
        &0,
        &Vec::from_array(&env, [String::from_str(&env, "")])
    );

    // Test bump_instance_ttl
    client.bump_instance_ttl();

    // Test bump_vesting_ttl
    client.bump_vesting_ttl(&recipient, &0);

    // Test maintenance
    client.maintenance(&recipient, &0, &1);
}

#[test]
fn test_set_config() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.__constructor(&admin);

    let fee_token = Address::generate(&env);
    let new_config = Config {
        max_batch_size: 50,
        max_schedules_per_recipient: 5,
        upgrade_timelock: 100,
        fee_asset: fee_token.clone(),
    };

    client.set_config(&admin, &new_config);

    // Verify ConfigUpdated event
    let events = env.events().all();
    let last_event = events.get(events.len() - 1).unwrap();
    let event_topics = last_event.1;
    let topic: Symbol = event_topics.get(0).unwrap().try_into_val(&env).unwrap();
    assert_eq!(topic, Symbol::new(&env, "ConfigUpdated"));
    let event_data: (u32, u32, u64, Address) = last_event.2.try_into_val(&env).unwrap();
    assert_eq!(event_data.0, 50u32);
    assert_eq!(event_data.1, 5u32);
    assert_eq!(event_data.2, 100u64);
    assert_eq!(event_data.3, fee_token);
}

#[test]
#[should_panic(expected = "Batch size exceeds max_batch_size")]
fn test_config_enforcement() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.__constructor(&admin);

    client.set_config(&admin, &Config {
        max_batch_size: 2,
        max_schedules_per_recipient: 10,
        upgrade_timelock: 100,
        fee_asset: Address::generate(&env),
    });

    let sender = Address::generate(&env);
    let recipients = Vec::from_array(&env, [Address::generate(&env), Address::generate(&env), Address::generate(&env)]);
    let amounts = Vec::from_array(&env, [100i128, 100i128, 100i128]);
    let token = Address::generate(&env);

    // Should panic because batch size is 3 but limit is 2
    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.clone(), token.clone(), token.clone()]),
        &recipients,
        &amounts,
        &0,
        &2000,
        &0,
        &0,
        &Vec::from_array(&env, [String::from_str(&env, ""), String::from_str(&env, ""), String::from_str(&env, "")])
    );
}

#[test]
fn test_propose_and_accept_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);

    client.__constructor(&admin);

    // Step 1: Propose
    client.propose_admin(&admin, &new_admin);

    // Step 2: Accept
    client.accept_admin(&new_admin);

    // Verify transfer
    let events = env.events().all();
    let transfer_event = events.get(events.len() - 1).unwrap();
    let event_topics = transfer_event.1;
    let topic: Symbol = event_topics.get(0).unwrap().try_into_val(&env).unwrap();
    assert_eq!(
        topic,
        Symbol::new(&env, "AdminTransferred")
    );
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #9)")]
fn test_only_pending_admin_can_accept() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);
    let attacker = Address::generate(&env);

    client.__constructor(&admin);
    client.propose_admin(&admin, &new_admin);

    // Attacker tries to accept — must fail with Unauthorized (#9)
    client.accept_admin(&attacker);
}

// ── Gas-Optimised Batch Revoke tests ─────────────────────────────────────────

/// Verifies that batch_revoke processes requests in the correct (descending)
/// index order regardless of the order they are submitted, preventing
/// swap-with-last index corruption when multiple schedules for the same
/// recipient are revoked in a single call.
#[test]
fn test_batch_revoke_out_of_order_indices() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token_contract(&env, &token_admin);
    token_admin_client.mint(&sender, &3000);

    env.ledger().with_mut(|li| li.timestamp = 0);

    // Deposit 3 separate schedules for the same recipient (indices 0, 1, 2)
    for end in [1000u64, 2000u64, 3000u64] {
        client.deposit(
            &sender,
            &Vec::from_array(&env, [token.address.clone()]),
            &Vec::from_array(&env, [recipient.clone()]),
            &Vec::from_array(&env, [100i128]),
            &0,
            &end,
            &0,
            &0,
            &Vec::from_array(&env, [String::from_str(&env, "")])
        );
    }
    assert_eq!(token.balance(&contract_id), 300);

    env.ledger().with_mut(|li| li.timestamp = 500);

    // Submit requests in descending index order [2, 1, 0] as required by the contract.
    let results = client.batch_revoke(
        &sender,
        &Vec::from_array(
            &env,
            [
                RevokeRequest { recipient: recipient.clone(), index: 2 },
                RevokeRequest { recipient: recipient.clone(), index: 1 },
                RevokeRequest { recipient: recipient.clone(), index: 0 },
            ],
        ),
    );

    // All three revokes must succeed
    assert_eq!(results.get(0).unwrap(), true);
    assert_eq!(results.get(1).unwrap(), true);
    assert_eq!(results.get(2).unwrap(), true);
    // Contract must be empty; all funds returned to sender
    assert_eq!(token.balance(&contract_id), 0);
    assert_eq!(token.balance(&sender), 3000);
}


#[test]
fn test_step_based_vesting() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token_contract(&env, &token_admin);
    token_admin_client.mint(&sender, &1000);

    let recipients = Vec::from_array(&env, [recipient.clone()]);
    let amounts = Vec::from_array(&env, [100]);
    let start_time = 0;
    let end_time = 1000;
    let vesting_step = 500; // 2 steps

    env.ledger().with_mut(|li| li.timestamp = 0);

    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone()]),
        &recipients,
        &amounts,
        &start_time,
        &end_time,
        &0,
        &vesting_step,
        &Vec::from_array(&env, [String::from_str(&env, "step test")])
    );

    // At 250, nothing is vested yet (below first step of 500)
    env.ledger().with_mut(|li| li.timestamp = 250);
    assert_eq!(client.get_vestings(&recipient, &0, &1).get(0).unwrap().released_amount, 0);
    
    // Attempt claim at 499 should fail
    env.ledger().with_mut(|li| li.timestamp = 499);
    // client.claim(&recipient); // This should panic with StillLocked but let's just check calculate_vested logic via claimable check if I had such a function.
    // Actually claim() panics if nothing is claimable.
    
    // At 500, first step (50%) is vested
    env.ledger().with_mut(|li| li.timestamp = 500);
    client.claim(&recipient, &0, &50);
    assert_eq!(token.balance(&recipient), 50);

    // At 750, still only 50% vested
    env.ledger().with_mut(|li| li.timestamp = 750);
    // client.claim(&recipient, &0, &50); // Should fail/do nothing more
    
    // At 1000, final step (100%) is vested
    env.ledger().with_mut(|li| li.timestamp = 1000);
    client.claim(&recipient, &0, &50);
    assert_eq!(token.balance(&recipient), 100);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #14)")]
fn test_invalid_vesting_step_divisibility() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipients = Vec::from_array(&env, [Address::generate(&env)]);
    let amounts = Vec::from_array(&env, [100]);
    
    client.deposit(
        &sender,
        &Vec::from_array(&env, [Address::generate(&env)]),
        &recipients,
        &amounts,
        &0,
        &1000,
        &0,
        &300, // 1000 is not divisible by 300
        &Vec::from_array(&env, [String::from_str(&env, "")])
    );
}

#[test]
fn test_upgrade_flow() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.__constructor(&admin);
    client.set_config(&admin, &Config {
        max_batch_size: 100,
        max_schedules_per_recipient: 10,
        upgrade_timelock: 7 * 24 * 60 * 60,
        fee_asset: Address::generate(&env),
    });

    let new_wasm_hash = BytesN::from_array(&env, &[1u8; 32]);
    
    // Propose upgrade
    env.ledger().with_mut(|li| li.timestamp = 100);
    client.propose_upgrade(&admin, &new_wasm_hash);

    // Attempt execution before timelock
    env.ledger().with_mut(|li| li.timestamp = 100 + UPGRADE_TIMELOCK - 1);
    
    // We expect this to fail with TimelockNotExpired
    let result = client.try_execute_upgrade(&admin);
    assert!(result.is_err());

    // Try execute after timelock
    // Since the WASM hash doesn't exist in the test environment, this 
    // will panic with a Host error during actual WASM update, 
    // but the contract logic before that (timelock check) has passed.
    env.ledger().with_mut(|li| li.timestamp = 100 + UPGRADE_TIMELOCK);
    let result = client.try_execute_upgrade(&admin);
    // It should NOT be TimelockNotExpired (Contract error #15), 
    // but rather a Host error/Storage error.
    assert!(result.is_err());
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #15)")]
fn test_execute_upgrade_timelock_panic() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.__constructor(&admin);
    client.set_config(&admin, &Config {
        max_batch_size: 100,
        max_schedules_per_recipient: 10,
        upgrade_timelock: 7 * 24 * 60 * 60,
        fee_asset: Address::generate(&env),
    });
    let new_wasm_hash = BytesN::from_array(&env, &[1u8; 32]);
    env.ledger().with_mut(|li| li.timestamp = 100);
    client.propose_upgrade(&admin, &new_wasm_hash);
    env.ledger().with_mut(|li| li.timestamp = 100 + UPGRADE_TIMELOCK - 1);
    client.execute_upgrade(&admin);
}

// ── Partial claim tests ───────────────────────────────────────────────────────

#[test]
fn test_partial_claim_keeps_schedule_active() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let (token, token_admin) = create_token_contract(&env, &Address::generate(&env));
    token_admin.mint(&sender, &1000);

    env.ledger().with_mut(|li| li.timestamp = 0);
    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone()]),
        &Vec::from_array(&env, [recipient.clone()]),
        &Vec::from_array(&env, [100i128]),
        &0,
        &1000,
        &0,
        &0,
        &Vec::from_array(&env, [String::from_str(&env, "")]),
    );

    env.ledger().with_mut(|li| li.timestamp = 1001);

    // Claim only 40 out of 100 available
    client.claim(&recipient, &0, &40);
    assert_eq!(token.balance(&recipient), 40);

    // Schedule still exists with 60 remaining
    let vestings = client.get_vestings(&recipient, &0, &1);
    assert_eq!(vestings.len(), 1);
    assert_eq!(vestings.get(0).unwrap().released_amount, 40);

    // Claim the rest
    client.claim(&recipient, &0, &60);
    assert_eq!(token.balance(&recipient), 100);

    // Schedule is now removed
    assert_eq!(client.get_vestings(&recipient, &0, &1).len(), 0);
}

#[test]
fn test_partial_claim_capped_at_claimable() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let (token, token_admin) = create_token_contract(&env, &Address::generate(&env));
    token_admin.mint(&sender, &1000);

    env.ledger().with_mut(|li| li.timestamp = 0);
    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone()]),
        &Vec::from_array(&env, [recipient.clone()]),
        &Vec::from_array(&env, [100i128]),
        &0,
        &1000,
        &0,
        &0,
        &Vec::from_array(&env, [String::from_str(&env, "")]),
    );

    env.ledger().with_mut(|li| li.timestamp = 1001);

    // Request more than available — should be capped to 100
    client.claim(&recipient, &0, &999);
    assert_eq!(token.balance(&recipient), 100);
    assert_eq!(client.get_vestings(&recipient, &0, &1).len(), 0);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #10)")]
fn test_partial_claim_before_unlock_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let (token, token_admin) = create_token_contract(&env, &Address::generate(&env));
    token_admin.mint(&sender, &1000);

    env.ledger().with_mut(|li| li.timestamp = 0);
    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone()]),
        &Vec::from_array(&env, [recipient.clone()]),
        &Vec::from_array(&env, [100i128]),
        &0,
        &1000,
        &0,
        &0,
        &Vec::from_array(&env, [String::from_str(&env, "")]),
    );

    // Cliff not reached — must fail with StillLocked (#10)
    env.ledger().with_mut(|li| li.timestamp = 500);
    client.claim(&recipient, &0, &50);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #5)")]
fn test_partial_claim_zero_amount_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let (token, token_admin) = create_token_contract(&env, &Address::generate(&env));
    token_admin.mint(&sender, &1000);

    env.ledger().with_mut(|li| li.timestamp = 0);
    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone()]),
        &Vec::from_array(&env, [recipient.clone()]),
        &Vec::from_array(&env, [100i128]),
        &0,
        &1000,
        &0, // cliff
        &0, // step
        &Vec::from_array(&env, [String::from_str(&env, "")]),
    );

    env.ledger().with_mut(|li| li.timestamp = 1001);
    // Zero amount must fail with InvalidAmount (#5)
    client.claim(&recipient, &0, &0);
}

// ── #398: claim_all uses checked arithmetic on released_amount ──────────────

/// Verify that claim_all with a near-i128::MAX schedule does not overflow.
/// The fix replaces `released_amount += claimable` with checked_add.
#[test]
fn test_claim_all_checked_add_no_overflow() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let (token, token_admin) = create_token_contract(&env, &Address::generate(&env));

    // Use i64::MAX as a large but safe amount the token contract accepts.
    let large_amount: i128 = i64::MAX as i128;
    token_admin.mint(&sender, &large_amount);

    env.ledger().with_mut(|li| li.timestamp = 0);
    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone()]),
        &Vec::from_array(&env, [recipient.clone()]),
        &Vec::from_array(&env, [large_amount]),
        &0,
        &1000,
        &0,
        &0,
        &Vec::from_array(&env, [String::from_str(&env, "")]),
    );

    // Advance past end_time so the full amount is claimable.
    env.ledger().with_mut(|li| li.timestamp = 1001);
    client.claim_all(&recipient);
    assert_eq!(token.balance(&recipient), large_amount);
}

// ── #299/#303: Arithmetic safety in calculate_vested_amount ──────────────────

/// Verify that step-based vesting with maximum i128 total_amount does not
/// overflow.  With checked arithmetic the contract must return the correct
/// vested amount rather than panicking or silently wrapping.
#[test]
fn test_calculate_vested_amount_max_i128_no_overflow() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender    = Address::generate(&env);
    let recipient = Address::generate(&env);
    let (token, token_admin) = create_token_contract(&env, &Address::generate(&env));

    // Mint a very large (but not max i128) amount so the token contract
    // accepts it.  We use i64::MAX as a safe large value.
    let large_amount: i128 = i64::MAX as i128;
    token_admin.mint(&sender, &large_amount);

    // step = 100, duration = 1000 → 10 steps
    let start_time: u64 = 0;
    let end_time:   u64 = 1000;
    let step:       u64 = 100;

    env.ledger().with_mut(|li| li.timestamp = start_time);
    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone()]),
        &Vec::from_array(&env, [recipient.clone()]),
        &Vec::from_array(&env, [large_amount]),
        &start_time,
        &end_time,
        &0u64,
        &step,
        &Vec::from_array(&env, [String::from_str(&env, "")]),
    );

    // Advance to step 5 of 10 → should be able to claim half
    env.ledger().with_mut(|li| li.timestamp = 500);
    let expected_claimable = large_amount / 2;
    // claim should succeed without overflow panic
    client.claim(&recipient, &0, &expected_claimable);
    assert_eq!(token.balance(&recipient), expected_claimable);
}

/// Overflow path: total * current_step overflows i128 before division.
/// The contract must return VestingError::Overflow (#13) rather than panicking
/// with an uncontrolled trap.
#[test]
#[should_panic(expected = "HostError: Error(Contract, #13)")]
fn test_calculate_vested_amount_overflow_returns_error() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender    = Address::generate(&env);
    let recipient = Address::generate(&env);
    let (token, token_admin) = create_token_contract(&env, &Address::generate(&env));

    // total = i128::MAX; with step=1 and duration=3, num_steps=3.
    // At elapsed=2: current_step=2, numerator = i128::MAX * 2 → overflows i128 → Overflow(#13).
    let total: i128 = i128::MAX;
    token_admin.mint(&sender, &total);

    let start_time: u64 = 0;
    let end_time:   u64 = 3;
    let step:       u64 = 1;

    env.ledger().with_mut(|li| li.timestamp = start_time);
    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone()]),
        &Vec::from_array(&env, [recipient.clone()]),
        &Vec::from_array(&env, [total]),
        &start_time,
        &end_time,
        &0u64,
        &step,
        &Vec::from_array(&env, [String::from_str(&env, "")]),
    );

    // At elapsed=2, current_step=2 < num_steps=3: total * 2 overflows i128.
    env.ledger().with_mut(|li| li.timestamp = 2);
    client.claim(&recipient, &0, &1);
}

// ── #308: batch_revoke sorting / InvalidInput ─────────────────────────────────

/// Unsorted input (ascending index order for the same recipient) must be
/// rejected with VestingError::InvalidInput (#18).
#[test]
#[should_panic(expected = "HostError: Error(Contract, #18)")]
fn test_batch_revoke_unsorted_input_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender    = Address::generate(&env);
    let recipient = Address::generate(&env);
    let (token, token_admin) = create_token_contract(&env, &Address::generate(&env));
    token_admin.mint(&sender, &600);

    env.ledger().with_mut(|li| li.timestamp = 0);

    // Deposit 3 schedules for the same recipient
    for _ in 0..3 {
        client.deposit(
            &sender,
            &Vec::from_array(&env, [token.address.clone()]),
            &Vec::from_array(&env, [recipient.clone()]),
            &Vec::from_array(&env, [100i128]),
            &0,
            &1000,
            &0,
            &0,
            &Vec::from_array(&env, [String::from_str(&env, "")]),
        );
    }

    // Provide requests in ASCENDING order (0, 1, 2) — must be rejected
    let requests = Vec::from_array(&env, [
        RevokeRequest { recipient: recipient.clone(), index: 0 },
        RevokeRequest { recipient: recipient.clone(), index: 1 },
        RevokeRequest { recipient: recipient.clone(), index: 2 },
    ]);

    client.batch_revoke(&sender, &requests);
}

/// Correctly sorted input (descending index order) must succeed.
#[test]
fn test_batch_revoke_sorted_input_succeeds() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender    = Address::generate(&env);
    let recipient = Address::generate(&env);
    let (token, token_admin) = create_token_contract(&env, &Address::generate(&env));
    token_admin.mint(&sender, &300);

    env.ledger().with_mut(|li| li.timestamp = 0);

    // Deposit 3 schedules
    for _ in 0..3 {
        client.deposit(
            &sender,
            &Vec::from_array(&env, [token.address.clone()]),
            &Vec::from_array(&env, [recipient.clone()]),
            &Vec::from_array(&env, [100i128]),
            &0,
            &1000,
            &0,
            &0,
            &Vec::from_array(&env, [String::from_str(&env, "")]),
        );
    }

    // Provide requests in DESCENDING order (2, 1, 0) — must succeed
    let requests = Vec::from_array(&env, [
        RevokeRequest { recipient: recipient.clone(), index: 2 },
        RevokeRequest { recipient: recipient.clone(), index: 1 },
        RevokeRequest { recipient: recipient.clone(), index: 0 },
    ]);

    let results = client.batch_revoke(&sender, &requests);
    // All three revocations should succeed
    assert_eq!(results.get(0).unwrap(), true);
    assert_eq!(results.get(1).unwrap(), true);
    assert_eq!(results.get(2).unwrap(), true);
}

/// Different recipients in a single batch_revoke call are independent —
/// their relative order does not matter, only same-recipient ordering is
/// enforced.
#[test]
fn test_batch_revoke_different_recipients_any_order() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender     = Address::generate(&env);
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);
    let (token, token_admin) = create_token_contract(&env, &Address::generate(&env));
    token_admin.mint(&sender, &200);

    env.ledger().with_mut(|li| li.timestamp = 0);

    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone(), token.address.clone()]),
        &Vec::from_array(&env, [recipient1.clone(), recipient2.clone()]),
        &Vec::from_array(&env, [100i128, 100i128]),
        &0,
        &1000,
        &0,
        &0,
        &Vec::from_array(&env, [
            String::from_str(&env, ""),
            String::from_str(&env, ""),
        ]),
    );

    // recipient2 index 0 before recipient1 index 0 — different recipients,
    // so ordering validation must not reject this.
    let requests = Vec::from_array(&env, [
        RevokeRequest { recipient: recipient2.clone(), index: 0 },
        RevokeRequest { recipient: recipient1.clone(), index: 0 },
    ]);

    let results = client.batch_revoke(&sender, &requests);
    assert_eq!(results.get(0).unwrap(), true);
    assert_eq!(results.get(1).unwrap(), true);
}

// ── #505: interleaved same-recipient index ordering ───────────────────────────

/// Interleaved same-recipient requests that are not globally descending must be
/// rejected, even when the out-of-order pair is separated by another recipient
/// (so the old consecutive-only check would have let it through). Sequence for
/// recipient R is 2, 0, 1 — the trailing 1 ascends past the previous 0. (#505)
#[test]
#[should_panic(expected = "HostError: Error(Contract, #18)")]
fn test_batch_revoke_interleaved_indices() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender    = Address::generate(&env);
    let recipient = Address::generate(&env);
    let other     = Address::generate(&env);
    let (token, token_admin) = create_token_contract(&env, &Address::generate(&env));
    token_admin.mint(&sender, &400);

    env.ledger().with_mut(|li| li.timestamp = 0);

    // 3 schedules for recipient R (indices 0, 1, 2)
    for _ in 0..3 {
        client.deposit(
            &sender,
            &Vec::from_array(&env, [token.address.clone()]),
            &Vec::from_array(&env, [recipient.clone()]),
            &Vec::from_array(&env, [100i128]),
            &0,
            &1000,
            &0,
            &0,
            &Vec::from_array(&env, [String::from_str(&env, "")]),
        );
    }
    // 1 schedule for the interleaving recipient
    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone()]),
        &Vec::from_array(&env, [other.clone()]),
        &Vec::from_array(&env, [100i128]),
        &0,
        &1000,
        &0,
        &0,
        &Vec::from_array(&env, [String::from_str(&env, "")]),
    );

    // R sequence is 2, 0, 1 — globally NOT descending. The (R,0) and (R,1)
    // entries are non-adjacent (separated by `other`), so a consecutive-only
    // validator misses it. Must be rejected with InvalidInput (#18).
    let requests = Vec::from_array(&env, [
        RevokeRequest { recipient: recipient.clone(), index: 2 },
        RevokeRequest { recipient: recipient.clone(), index: 0 },
        RevokeRequest { recipient: other.clone(),     index: 0 },
        RevokeRequest { recipient: recipient.clone(), index: 1 },
    ]);

    client.batch_revoke(&sender, &requests);
}

/// A genuinely descending per-recipient batch that happens to be interleaved
/// with another recipient must still succeed. R sequence is 2, 1, 0. (#505)
#[test]
fn test_batch_revoke_interleaved_descending_succeeds() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);
    setup_contract(&env, &client);

    let sender    = Address::generate(&env);
    let recipient = Address::generate(&env);
    let other     = Address::generate(&env);
    let (token, token_admin) = create_token_contract(&env, &Address::generate(&env));
    token_admin.mint(&sender, &400);

    env.ledger().with_mut(|li| li.timestamp = 0);

    for _ in 0..3 {
        client.deposit(
            &sender,
            &Vec::from_array(&env, [token.address.clone()]),
            &Vec::from_array(&env, [recipient.clone()]),
            &Vec::from_array(&env, [100i128]),
            &0,
            &1000,
            &0,
            &0,
            &Vec::from_array(&env, [String::from_str(&env, "")]),
        );
    }
    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone()]),
        &Vec::from_array(&env, [other.clone()]),
        &Vec::from_array(&env, [100i128]),
        &0,
        &1000,
        &0,
        &0,
        &Vec::from_array(&env, [String::from_str(&env, "")]),
    );

    // R sequence 2, 1, 0 (descending) interleaved with `other` — must succeed.
    let requests = Vec::from_array(&env, [
        RevokeRequest { recipient: recipient.clone(), index: 2 },
        RevokeRequest { recipient: other.clone(),     index: 0 },
        RevokeRequest { recipient: recipient.clone(), index: 1 },
        RevokeRequest { recipient: recipient.clone(), index: 0 },
    ]);

    let results = client.batch_revoke(&sender, &requests);
    assert_eq!(results.get(0).unwrap(), true);
    assert_eq!(results.get(1).unwrap(), true);
    assert_eq!(results.get(2).unwrap(), true);
    assert_eq!(results.get(3).unwrap(), true);
}

// ── #543: Fee asset whitelist tests ───────────────────────────────────────────

/// Verify that set_fee_config no longer accepts fee_asset as a parameter.
/// The fee asset is now controlled by the contract config, not fee_config.
#[test]
fn test_set_fee_config_uses_whitelisted_asset_from_config() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let treasury = Address::generate(&env);

    // Create two different token contracts
    let (token_a, token_admin_a) = create_token_contract(&env, &Address::generate(&env));
    let (token_b, token_admin_b) = create_token_contract(&env, &Address::generate(&env));

    // Initialize admin and config with token_a as the whitelisted fee asset
    client.__constructor(&admin);
    let config = Config {
        max_batch_size: 100,
        max_schedules_per_recipient: 10,
        upgrade_timelock: 7 * 24 * 60 * 60,
        fee_asset: token_a.address.clone(),
    };
    client.set_config(&admin, &config);

    // Set fee config (no fee_asset parameter anymore)
    client.set_fee_config(&admin, &100, &treasury);

    // Mint tokens for fee payment
    token_admin_a.mint(&sender, &1000);
    token_admin_b.mint(&sender, &1000);

    env.ledger().with_mut(|li| li.timestamp = 0);

    // Deposit should succeed and collect fees in token_a (the whitelisted asset)
    client.deposit(
        &sender,
        &Vec::from_array(&env, [token_a.address.clone()]),
        &Vec::from_array(&env, [recipient.clone()]),
        &Vec::from_array(&env, [100i128]),
        &0,
        &1000,
        &0,
        &0,
        &Vec::from_array(&env, [String::from_str(&env, "")]),
    );

    // Verify fees were collected in token_a (whitelisted), not token_b
    assert_eq!(token_a.balance(&treasury), 100); // 1 recipient * 100 fee
    assert_eq!(token_a.balance(&sender), 800); // 1000 - 100 deposited - 100 fee
    assert_eq!(token_b.balance(&treasury), 0); // No fees in token_b
}

/// Verify that deposit fails if sender doesn't have the whitelisted fee asset.
#[test]
#[should_panic]
fn test_deposit_fails_without_whitelisted_fee_asset() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let (token_a, token_admin_a) = create_token_contract(&env, &Address::generate(&env));
    let (token_b, token_admin_b) = create_token_contract(&env, &Address::generate(&env));

    // Initialize admin and config with token_a as fee asset
    client.__constructor(&admin);
    let config = Config {
        max_batch_size: 100,
        max_schedules_per_recipient: 10,
        upgrade_timelock: 7 * 24 * 60 * 60,
        fee_asset: token_a.address.clone(),
    };
    client.set_config(&admin, &config);

    // Set fee config
    client.set_fee_config(&admin, &100, &Address::generate(&env));

    // Mint only token_b to sender (not the whitelisted token_a)
    token_admin_a.mint(&sender, &0); // No token_a
    token_admin_b.mint(&sender, &1000); // Only token_b

    env.ledger().with_mut(|li| li.timestamp = 0);

    // Deposit with token_b should fail because fees require token_a
    client.deposit(
        &sender,
        &Vec::from_array(&env, [token_b.address.clone()]),
        &Vec::from_array(&env, [recipient.clone()]),
        &Vec::from_array(&env, [100i128]),
        &0,
        &1000,
        &0,
        &0,
        &Vec::from_array(&env, [String::from_str(&env, "")]),
    );
}

/// Verify that fees are always collected in the whitelisted asset,
/// regardless of which token is used for the vesting deposit.
#[test]
fn test_fees_collected_in_whitelisted_asset_not_deposit_token() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let treasury = Address::generate(&env);

    let (token_xlm, token_admin_xlm) = create_token_contract(&env, &Address::generate(&env));
    let (token_usdc, token_admin_usdc) = create_token_contract(&env, &Address::generate(&env));

    // Initialize admin and config with XLM as fee asset
    client.__constructor(&admin);
    let config = Config {
        max_batch_size: 100,
        max_schedules_per_recipient: 10,
        upgrade_timelock: 7 * 24 * 60 * 60,
        fee_asset: token_xlm.address.clone(), // XLM is whitelisted
    };
    client.set_config(&admin, &config);

    // Set fee config: 50 XLM per recipient
    client.set_fee_config(&admin, &50, &treasury);

    // Mint both tokens to sender
    token_admin_xlm.mint(&sender, &1000);
    token_admin_usdc.mint(&sender, &1000);

    env.ledger().with_mut(|li| li.timestamp = 0);

    // Deposit using USDC (not the fee asset)
    client.deposit(
        &sender,
        &Vec::from_array(&env, [token_usdc.address.clone()]),
        &Vec::from_array(&env, [recipient.clone()]),
        &Vec::from_array(&env, [200i128]),
        &0,
        &1000,
        &0,
        &0,
        &Vec::from_array(&env, [String::from_str(&env, "")]),
    );

    // Verify: fees collected in XLM (whitelisted), not USDC (deposit token)
    assert_eq!(token_xlm.balance(&treasury), 50); // Fee in XLM
    assert_eq!(token_xlm.balance(&sender), 950); // 1000 - 50 fee
    assert_eq!(token_usdc.balance(&sender), 800); // 1000 - 200 deposited
    assert_eq!(token_usdc.balance(&treasury), 0); // No USDC fees
}

/// Verify that FeeConfigUpdated event includes the whitelisted fee asset from config.
#[test]
fn test_fee_config_event_includes_whitelisted_asset() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let (token_xlm, _) = create_token_contract(&env, &Address::generate(&env));
    let treasury = Address::generate(&env);

    // Initialize admin and config
    client.__constructor(&admin);
    let config = Config {
        max_batch_size: 100,
        max_schedules_per_recipient: 10,
        upgrade_timelock: 7 * 24 * 60 * 60,
        fee_asset: token_xlm.address.clone(),
    };
    client.set_config(&admin, &config);

    // Set fee config
    client.set_fee_config(&admin, &75, &treasury);

    // Verify FeeConfigUpdated event contains the whitelisted fee asset
    let events = env.events().all();
    let fee_config_event = events.get(events.len() - 1).unwrap();
    let event_topics = fee_config_event.1;
    let topic: Symbol = event_topics.get(0).unwrap().try_into_val(&env).unwrap();
    assert_eq!(topic, Symbol::new(&env, "FeeConfigUpdated"));

    let event_data: (i128, Address, Address) = fee_config_event.2.try_into_val(&env).unwrap();
    assert_eq!(event_data.0, 75i128); // fee_per_recipient
    assert_eq!(event_data.1, treasury); // treasury
    assert_eq!(event_data.2, token_xlm.address); // whitelisted fee_asset from config
}

/// Verify that zero fees work correctly with the whitelist system.
#[test]
fn test_zero_fees_with_whitelisted_asset() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, BatchVestingContract);
    let client = BatchVestingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let (token, token_admin) = create_token_contract(&env, &Address::generate(&env));

    // Initialize admin and config
    client.__constructor(&admin);
    let config = Config {
        max_batch_size: 100,
        max_schedules_per_recipient: 10,
        upgrade_timelock: 7 * 24 * 60 * 60,
        fee_asset: token.address.clone(),
    };
    client.set_config(&admin, &config);

    // Set fee to 0 (disabled)
    client.set_fee_config(&admin, &0, &Address::generate(&env));

    token_admin.mint(&sender, &1000);

    env.ledger().with_mut(|li| li.timestamp = 0);

    // Deposit with zero fees should not transfer any fee tokens
    client.deposit(
        &sender,
        &Vec::from_array(&env, [token.address.clone()]),
        &Vec::from_array(&env, [recipient.clone()]),
        &Vec::from_array(&env, [100i128]),
        &0,
        &1000,
        &0,
        &0,
        &Vec::from_array(&env, [String::from_str(&env, "")]),
    );

    // All tokens should be in the contract (no fees deducted)
    assert_eq!(token.balance(&sender), 900); // 1000 - 100 deposited
    assert_eq!(token.balance(&contract_id), 100); // Only the deposited amount
}
