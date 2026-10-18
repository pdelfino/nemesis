/* global document */
// A remote script the internal page's CSP must refuse (#50). If it ever runs,
// the spec finds the element it adds and fails.
globalThis.__pwned = 'remote'
document.body.appendChild(Object.assign(document.createElement('p'), { id: 'pwned-remote' }))
