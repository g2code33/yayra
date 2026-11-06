export async function mountAbout({ root, versionUrl = './version.json' }) {
  const section = document.createElement('section');
  section.id = 'settings-about';
  section.innerHTML = '<h2>Settings → About</h2><dl><dt>Version</dt><dd id="about-version">loading</dd><dt>Commit</dt><dd id="about-sha">loading</dd><dt>Built</dt><dd id="about-built-at">loading</dd></dl>';
  root.append(section);
  try {
    const info = await fetch(versionUrl, { cache: 'no-store' }).then((response) => response.json());
    section.querySelector('#about-version').textContent = info.version;
    section.querySelector('#about-sha').textContent = info.sha;
    section.querySelector('#about-built-at').textContent = info.builtAt;
  } catch (error) {
    section.querySelector('#about-version').textContent = 'unknown';
    section.querySelector('#about-sha').textContent = 'unknown';
    section.querySelector('#about-built-at').textContent = error.message;
  }
  return section;
}
