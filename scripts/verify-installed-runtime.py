#!/usr/bin/env python3
"""Verify every installed path into the immutable shared runtime cohort."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import tarfile
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--archives', type=Path, default=Path('node_modules/.cache/runtime-archives'))
parser.add_argument('--output', type=Path, default=Path('test-results/runtime-closure.json'))
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
pins = json.loads((root / 'scripts/runtime-cohort.json').read_text())['packages']
# The app's ratchet is released independently of the shared transport cohort.
# Audit every installed path into its immutable archive at the same build gate.
pins['nostr-double-ratchet'] = {
    'version': '0.0.189',
    'url': 'https://registry.npmjs.org/nostr-double-ratchet/-/nostr-double-ratchet-0.0.189.tgz',
    'sha256': 'fc1cc2fd6ecd97ca0956c8a5ac08912513bf62ee808130a9953b494139d7e950',
    'integrity': 'sha512-FNDz6KvHBYIQQrMW02Pyw/1gYFrijX8lnpITCdA+X+A/nRMjUUilzWTAsD1IeRTDbeBEJ4rxQ284bIpPXzR9kw==',
}
nodes, missing = {}, []


def resolve(base, name):
    for parent in (base, *base.parents):
        target = parent / 'node_modules' / name
        if (target / 'package.json').is_file():
            return target.resolve()


def visit(target):
    key = str(target)
    if key in nodes:
        return
    manifest = json.loads((target / 'package.json').read_text())
    node = nodes[key] = {'name': manifest['name'], 'version': manifest.get('version'), 'edges': {}}
    names = set(manifest.get('dependencies', {})) | set(manifest.get('optionalDependencies', {})) | set(manifest.get('peerDependencies', {}))
    if target == root:
        names |= set(manifest.get('devDependencies', {}))
    for name in sorted(names):
        dependency = resolve(target, name)
        if dependency is None:
            required = name in manifest.get('dependencies', {}) and name not in manifest.get('optionalDependencies', {})
            missing.append({'from': node['name'], 'name': name, 'required': required})
        else:
            node['edges'][name] = str(dependency)
            visit(dependency)


visit(root)
assert not any(entry['required'] for entry in missing), missing
args.archives.mkdir(parents=True, exist_ok=True)
verified = []
for target, node in nodes.items():
    pin = pins.get(node['name'])
    if pin is None:
        continue
    assert node['version'] == pin['version'], node
    archive = args.archives / pin['url'].rsplit('/', 1)[-1]
    if not archive.exists():
        archive.write_bytes(urllib.request.urlopen(pin['url'], timeout=60).read())
    raw = archive.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == pin['sha256'], archive
    assert 'sha512-' + base64.b64encode(hashlib.sha512(raw).digest()).decode() == pin['integrity'], archive
    files = {}
    with tarfile.open(archive) as tar:
        for entry in tar:
            if not entry.isfile():
                continue
            name = entry.name.removeprefix('package/')
            assert not name.startswith('/') and '..' not in Path(name).parts, name
            expected = tar.extractfile(entry).read()
            actual = (Path(target) / name).read_bytes()
            assert actual == expected, (node['name'], name)
            files[name] = hashlib.sha256(actual).hexdigest()
    incoming = [{'from': source, 'dependency': name} for source, parent in nodes.items()
                for name, dependency in parent['edges'].items() if dependency == target]
    verified.append({'name': node['name'], 'version': node['version'], 'installedPath': target,
                     'archiveSHA256': pin['sha256'], 'files': files, 'incomingPaths': incoming})
for name in ('@fips/core', '@fips/tcp', 'nostr-pubsub', 'nostr-social-graph', 'nostr-double-ratchet'):
    assert sum(item['name'] == name for item in verified) == 1, name
report = {'source': root.name, 'lockSHA256': hashlib.sha256((root / 'pnpm-lock.yaml').read_bytes()).hexdigest(),
          'packagesInspected': len(nodes), 'verified': verified, 'uninstalledOptionalOrPeer': missing}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'packagesInspected': len(nodes), 'cohortInstallations': len(verified),
                  'archiveMembersVerified': sum(len(item['files']) for item in verified),
                  'incomingPaths': sum(len(item['incomingPaths']) for item in verified)}))
