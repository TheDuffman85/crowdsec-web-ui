#!/bin/bash
git fetch origin
git checkout dev
git reset --hard origin/main
git push origin dev --force