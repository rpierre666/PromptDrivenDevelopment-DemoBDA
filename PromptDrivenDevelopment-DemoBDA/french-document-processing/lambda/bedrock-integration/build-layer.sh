#!/bin/bash
# build-layer.sh

set -e

LAYER_DIR="lambda-layer/bedrock-integration"
PYTHON_DIR="${LAYER_DIR}/python"

echo "Installing dependencies for Bedrock integration Lambda layer..."

# Create python directory if it doesn't exist
mkdir -p "${PYTHON_DIR}"

# Install dependencies
pip install -r "${LAYER_DIR}/requirements.txt" -t "${PYTHON_DIR}"

echo "Lambda layer build complete!"