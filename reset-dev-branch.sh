#!/bin/bash

read -p "This will reset 'dev' to 'origin/main' and FORCE PUSH. Are you sure? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]
then
    echo "Aborted."
    exit 1
fi

git fetch origin
git checkout dev
git reset --hard origin/main
git push origin dev --force