#!/usr/bin/env python3
"""Check that the recipe builds the same provisioner source that CI tests."""
from pathlib import Path
import re
import subprocess


if __name__ == '__main__':
    shared = Path(__file__).resolve().parents[1] / 'pi-base'
    recipe = shared / 'yocto/meta-pi-base/recipes-connectivity/wifi-provisioner/wifi-provisioner_0.1.0.bb'
    match = re.search(r'^SRCREV = "([0-9a-f]{40})"$', recipe.read_text(), re.MULTILINE)
    if not match:
        raise SystemExit('Expected a pinned provisioner SRCREV')
    subprocess.run(['git', '-C', str(shared), 'diff', '--exit-code',
                    match[1], 'HEAD', '--', 'wifi-provisioner'], check=True)
    print(f'Provisioner SRCREV {match[1]} matches the tested source')
