#!/bin/bash

set -e

NETWORK="${1:-local}"
ACCOUNT="${2:-alice}"
ADMIN_ADDRESS="${3:-$ACCOUNT}"

echo "Deploying Batch Vesting contract to $NETWORK network using account $ACCOUNT..."

# Build the contract
cd contracts/batch-vesting
cargo build --target wasm32-unknown-unknown --release

# Install and deploy
CONTRACT_ID=$(stellar contract deploy \
    --wasm target/wasm32-unknown-unknown/release/batch_vesting.wasm \
    --source "$ACCOUNT" \
    --network "$NETWORK")

echo "Contract deployed successfully!"
echo "CONTRACT_ID: $CONTRACT_ID"

# Initialize the contract admin atomically during deployment.
stellar contract invoke \
    --id "$CONTRACT_ID" \
    --source "$ACCOUNT" \
    --network "$NETWORK" \
    -- __constructor \
    --admin "$ADMIN_ADDRESS"

echo "Contract admin initialized for $ADMIN_ADDRESS"

# Save contract ID to a file for the app to use
echo "$CONTRACT_ID" > ../../contract_id_$NETWORK.txt
