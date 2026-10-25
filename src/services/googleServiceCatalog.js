/**
 * Google Services catalog used by Yayra's in-app account session.
 *
 * This module contains no credentials. It defines the exact Google-owned
 * product destinations and the allow-listed read-only API endpoints that the
 * trusted desktop process or Cloudflare Worker may call with a server-held
 * OAuth bearer. Browser/mobile renderers receive only normalized display data.
 */

export const GOOGLE_SERVICES_SCOPES = Object.freeze([
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/photoslibrary.readonly',
  'https://www.googleapis.com/auth/tasks.readonly',
  'https://www.googleapis.com/auth/classroom.courses.readonly'
]);

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const CONTACTS_SCOPE = 'https://www.googleapis.com/auth/contacts.readonly';
const PHOTOS_SCOPE = 'https://www.googleapis.com/auth/photoslibrary.readonly';
const TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks.readonly';
const CLASSROOM_SCOPE = 'https://www.googleapis.com/auth/classroom.courses.readonly';

const product = (id, title, url, options = {}) => Object.freeze({
  id, title, url, scope: null, api: null, icon: 'G', group: 'Google', ...options
});

export const GOOGLE_SERVICE_CATALOG = Object.freeze([
  product('account', 'Google Account', 'https://myaccount.google.com/', { icon: '👤', group: 'Account' }),
  product('gmail', 'Gmail', 'https://mail.google.com/mail/u/0/#inbox', {
    scope: GMAIL_SCOPE,
    api: 'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10',
    icon: '✉', group: 'Communication'
  }),
  product('calendar', 'Calendar', 'https://calendar.google.com/calendar/u/0/r', {
    scope: CALENDAR_SCOPE,
    api: 'https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=10&singleEvents=true&orderBy=startTime',
    icon: '📅', group: 'Communication'
  }),
  product('contacts', 'Contacts', 'https://contacts.google.com/', {
    scope: CONTACTS_SCOPE,
    api: 'https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,photos&pageSize=10',
    icon: '👥', group: 'Communication'
  }),
  product('meet', 'Meet', 'https://meet.google.com/', { scope: CALENDAR_SCOPE, icon: '🎥', group: 'Communication' }),
  product('chat', 'Google Chat', 'https://chat.google.com/', { scope: GMAIL_SCOPE, icon: '💬', group: 'Communication' }),
  product('voice', 'Google Voice', 'https://voice.google.com/', { scope: GMAIL_SCOPE, icon: '☎', group: 'Communication' }),
  product('drive', 'Drive', 'https://drive.google.com/drive/u/0/my-drive', {
    scope: DRIVE_SCOPE,
    api: 'https://www.googleapis.com/drive/v3/files?pageSize=10&fields=files(id,name,mimeType,modifiedTime,webViewLink)&orderBy=modifiedTime%20desc',
    icon: '▲', group: 'Workspace'
  }),
  product('docs', 'Docs', 'https://docs.google.com/document/u/0/', {
    scope: DRIVE_SCOPE,
    api: "https://www.googleapis.com/drive/v3/files?pageSize=10&fields=files(id,name,modifiedTime,webViewLink)&q=mimeType%3D'application%2Fvnd.google-apps.document'",
    icon: '📄', group: 'Workspace'
  }),
  product('sheets', 'Sheets', 'https://docs.google.com/spreadsheets/u/0/', {
    scope: DRIVE_SCOPE,
    api: "https://www.googleapis.com/drive/v3/files?pageSize=10&fields=files(id,name,modifiedTime,webViewLink)&q=mimeType%3D'application%2Fvnd.google-apps.spreadsheet'",
    icon: '▦', group: 'Workspace'
  }),
  product('slides', 'Slides', 'https://docs.google.com/presentation/u/0/', {
    scope: DRIVE_SCOPE,
    api: "https://www.googleapis.com/drive/v3/files?pageSize=10&fields=files(id,name,modifiedTime,webViewLink)&q=mimeType%3D'application%2Fvnd.google-apps.presentation'",
    icon: '▤', group: 'Workspace'
  }),
  product('forms', 'Forms', 'https://docs.google.com/forms/u/0/', { scope: DRIVE_SCOPE, icon: '▧', group: 'Workspace' }),
  product('sites', 'Sites', 'https://sites.google.com/', { scope: DRIVE_SCOPE, icon: '🌐', group: 'Workspace' }),
  product('keep', 'Keep', 'https://keep.google.com/', { icon: '💡', group: 'Workspace' }),
  product('tasks', 'Tasks', 'https://tasks.google.com/', {
    scope: TASKS_SCOPE,
    api: 'https://tasks.googleapis.com/tasks/v1/lists/@default/tasks?maxResults=10&showCompleted=false',
    icon: '✓', group: 'Workspace'
  }),
  product('classroom', 'Classroom', 'https://classroom.google.com/', {
    scope: CLASSROOM_SCOPE,
    api: 'https://classroom.googleapis.com/v1/courses?pageSize=10',
    icon: '🎓', group: 'Workspace'
  }),
  product('photos', 'Photos', 'https://photos.google.com/', {
    scope: PHOTOS_SCOPE,
    api: 'https://photoslibrary.googleapis.com/v1/mediaItems?pageSize=10',
    icon: '🌈', group: 'Media'
  }),
  product('youtube', 'YouTube', 'https://www.youtube.com/', {
    scope: YOUTUBE_SCOPE,
    api: 'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true&maxResults=10',
    icon: '▶', group: 'Media'
  }),
  product('youtube-studio', 'YouTube Studio', 'https://studio.youtube.com/', { scope: YOUTUBE_SCOPE, icon: '🎬', group: 'Media' }),
  product('play', 'Google Play', 'https://play.google.com/', { icon: '◢', group: 'Media' }),
  product('books', 'Books', 'https://books.google.com/', { icon: '📚', group: 'Media' }),
  product('podcasts', 'Podcasts', 'https://podcasts.google.com/', { icon: '🎙', group: 'Media' }),
  product('maps', 'Maps', 'https://www.google.com/maps', { icon: '📍', group: 'Discover' }),
  product('earth', 'Earth', 'https://earth.google.com/', { icon: '🌍', group: 'Discover' }),
  product('translate', 'Translate', 'https://translate.google.com/', { icon: '文', group: 'Discover' }),
  product('news', 'News', 'https://news.google.com/', { icon: '📰', group: 'Discover' }),
  product('search', 'Search', 'https://www.google.com/', { icon: '🔎', group: 'Discover' }),
  product('gemini', 'Gemini', 'https://gemini.google.com/', { icon: '✦', group: 'Discover' }),
  product('scholar', 'Scholar', 'https://scholar.google.com/', { icon: '🎓', group: 'Discover' }),
  product('shopping', 'Shopping', 'https://shopping.google.com/', { icon: '🛍', group: 'Discover' }),
  product('travel', 'Travel', 'https://www.google.com/travel/', { icon: '✈', group: 'Discover' }),
  product('finance', 'Finance', 'https://www.google.com/finance/', { icon: '₿', group: 'Discover' }),
  product('ads', 'Ads', 'https://ads.google.com/', { icon: '📢', group: 'Professional' }),
  product('analytics', 'Analytics', 'https://analytics.google.com/', { icon: '📊', group: 'Professional' }),
  product('cloud', 'Cloud Console', 'https://console.cloud.google.com/', { icon: '☁', group: 'Professional' }),
  product('workspace-admin', 'Admin Console', 'https://admin.google.com/', { icon: '⚙', group: 'Professional' }),
  product('groups', 'Groups', 'https://groups.google.com/', { icon: '👥', group: 'Professional' })
]);

export const GOOGLE_SERVICE_IDS = new Set(GOOGLE_SERVICE_CATALOG.map((service) => service.id));

export function googleServiceById(id) {
  return GOOGLE_SERVICE_CATALOG.find((service) => service.id === id) || null;
}

export function googleServiceDestination(id, email = '') {
  const service = googleServiceById(id);
  if (!service) return null;
  try {
    const url = new URL(service.url);
    if (email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) url.searchParams.set('authuser', email);
    return url.toString();
  } catch {
    return null;
  }
}

export function googleServiceApiUrl(id, now = Date.now()) {
  const service = googleServiceById(id);
  if (!service?.api) return null;
  try {
    const url = new URL(service.api);
    if (id === 'calendar') url.searchParams.set('timeMin', new Date(Math.max(0, Number(now) || Date.now())).toISOString());
    return url;
  } catch {
    return null;
  }
}

function cleanText(value, max = 300) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function safeHttpsUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.toString().slice(0, 2048) : '';
  } catch { return ''; }
}

export function normalizeGoogleServiceItems(id, payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const items = [];
  const push = (title, detail = '', url = '', idValue = '') => {
    const cleanTitle = cleanText(title, 160);
    if (!cleanTitle) return;
    items.push({ id: cleanText(idValue, 200), title: cleanTitle, detail: cleanText(detail, 300), url: safeHttpsUrl(url) });
  };

  if (id === 'gmail') {
    const count = Number.isFinite(Number(source.resultSizeEstimate)) ? Number(source.resultSizeEstimate) : 0;
    push(count ? `${count} recent mailbox results` : 'Mailbox accessible', 'Read-only Gmail API is connected.', 'https://mail.google.com/mail/u/0/#inbox', 'gmail');
  } else if (['drive', 'docs', 'sheets', 'slides'].includes(id)) {
    for (const file of Array.isArray(source.files) ? source.files.slice(0, 10) : []) {
      push(file?.name, file?.modifiedTime || file?.mimeType || '', file?.webViewLink, file?.id);
    }
  } else if (id === 'calendar') {
    for (const event of Array.isArray(source.items) ? source.items.slice(0, 10) : []) {
      push(event?.summary, event?.start?.dateTime || event?.start?.date || '', event?.htmlLink, event?.id);
    }
  } else if (id === 'contacts') {
    for (const person of Array.isArray(source.connections) ? source.connections.slice(0, 10) : []) {
      const name = person?.names?.[0]?.displayName || person?.emailAddresses?.[0]?.value;
      push(name, person?.emailAddresses?.[0]?.value || '', person?.photos?.[0]?.url, person?.resourceName);
    }
  } else if (id === 'tasks') {
    for (const task of Array.isArray(source.items) ? source.items.slice(0, 10) : []) push(task?.title, task?.due || task?.notes || '', '', task?.id);
  } else if (id === 'classroom') {
    for (const course of Array.isArray(source.courses) ? source.courses.slice(0, 10) : []) push(course?.name, course?.section || course?.courseState || '', course?.alternateLink, course?.id);
  } else if (id === 'photos') {
    for (const media of Array.isArray(source.mediaItems) ? source.mediaItems.slice(0, 10) : []) push(media?.filename, media?.mimeType || '', media?.productUrl, media?.id);
  } else if (id === 'youtube') {
    for (const channel of Array.isArray(source.items) ? source.items.slice(0, 10) : []) {
      const stats = channel?.statistics || {};
      push(channel?.snippet?.title, `${stats.subscriberCount || '0'} subscribers`, '', channel?.id);
    }
  }
  return { items, count: items.length, truncated: items.length >= 10 };
}
