#!/bin/bash
if curl -sf --max-time 2 http://localhost/nginx-health > /dev/null 2>&1; then
    exit 0
else
    exit 1
fi
