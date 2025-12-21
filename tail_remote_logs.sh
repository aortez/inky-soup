#!/bin/bash
# Tails the remote logs.

DEPLOY_USER="${DEPLOY_USER:-inky}"
INKY_SOUP_IP="${INKY_SOUP_IP:-inky-soup.local}"

ssh "$DEPLOY_USER@$INKY_SOUP_IP" "sudo journalctl -u inky-soup-server.service -f --output=short-precise"
