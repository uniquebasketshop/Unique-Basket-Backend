import fs from 'fs';
import path from 'path';
import { AVATAR_IDS } from '../src/utils/avatars';

/** The built-in avatar ids (D-024) must be the same in the backend, the app and the admin panel. */
describe('Avatar ids are the same everywhere', () => {
  const root = path.resolve(__dirname, '..', '..');
  const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

  it('app list matches the backend', () => {
    const dart = read('apps/customer_app/lib/features/profile/presentation/widgets/profile_avatar.dart');
    const ids = [...dart.matchAll(/ProfileAvatarOption\('([a-z]+)'/g)].map((m) => m[1]);
    expect(ids.sort()).toEqual([...AVATAR_IDS].sort());
  });

  it('admin panel list matches the backend', () => {
    const ts = read('apps/admin/src/utils/avatars.ts');
    const ids = [...ts.matchAll(/^\s+([a-z]+): \{ emoji:/gm)].map((m) => m[1]);
    expect(ids.sort()).toEqual([...AVATAR_IDS].sort());
  });
});
