#!/bin/bash
response=$(curl -sf --max-time 2 http://localhost:3000/health)
if [ $? -eq 0 ]; then exit 0; else exit 1; fi
