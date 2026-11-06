export function resolvePackageAssetPath(platform, archivePath) {
  if (platform === 'ios' || platform === 'android' || platform === 'pwa') return null;
  if (!archivePath) return null;
  return String(archivePath).replace(/^app\.asar[\\/]/, '');
}
