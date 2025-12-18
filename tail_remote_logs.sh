#!/bin/bash
# Tails the remote logs.

DEPLOY_USER="${DEPLOY_USER:-pi}"
INKY_SOUP_IP="${INKY_SOUP_IP:-inky-soup.local}"

ssh "$DEPLOY_USER@$INKY_SOUP_IP" "journalctl -u inky-soup.service -f --output=short-precise"
