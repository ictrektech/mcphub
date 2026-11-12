"""Offline checks of the pull archive and CPU/NVIDIA isolation contract."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
import yaml

spec = importlib.util.spec_from_file_location('vos_package', Path(__file__).with_name('package.py'))
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)

class PackageTests(unittest.TestCase):
    def test_archive_and_profiles(self):
        with tempfile.TemporaryDirectory(prefix='mcphub-package-', dir=os.environ.get('TMPDIR')) as temp:
            packager.DIST = Path(temp)
            images = {key: 'registry.example/test/mcphub:offline-test' for key in packager.PROFILES}
            stage = Path(temp) / 'staging'
            packager.render('1.2.3-vos.01', images, stage)
            output = packager.package('1.2.3-vos.01', stage)
            self.assertTrue(output.is_file())
            compose = yaml.safe_load((stage / 'docker-compose.yml').read_text())
            manifest = yaml.safe_load((stage / 'manifest.yml').read_text())
            self.assertEqual({p['name'] for p in manifest['profiles']},
                             {p for s in compose['services'].values() for p in s['profiles']})
            for service in compose['services'].values():
                cpu = service['profiles'][0].endswith('without-cuda')
                self.assertEqual(service.get('runtime'), None if cpu else 'nvidia')
                self.assertNotIn('privileged', service)
                self.assertTrue(all('docker.sock' not in volume for volume in service['volumes']))
                self.assertEqual(service['environment']['VOS_AUTH_ENABLED'], 'true')
                self.assertEqual(service['environment']['MCPHUB_VOS_VERSION'], '1.2.3-vos.01')
            for profile in manifest['profiles']:
                self.assertEqual(set(profile['conflicts']), {p['name'] for p in manifest['profiles']} - {profile['name']})

    def test_feishu_column_coordinates(self):
        self.assertEqual([packager.column_name(i) for i in [1, 26, 27, 702]], ['A', 'Z', 'AA', 'ZZ'])

    def test_missing_image_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix='mcphub-missing-', dir=os.environ.get('TMPDIR')) as temp:
            with self.assertRaisesRegex(RuntimeError, 'unrendered image'):
                packager.render('1.2.3-vos.01', {}, Path(temp) / 'stage')

if __name__ == '__main__':
    unittest.main()
