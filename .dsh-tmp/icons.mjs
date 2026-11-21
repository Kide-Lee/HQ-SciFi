const names = ['pen-line','sparkles','calendar-days','layers','book-open','bell','search','circle-dollar-sign','message-circle','chevron-right','eye','thumbs-up','star','clock','bookmark','settings']
const out = {}
for (const n of names) {
  const mod = await import(`/home/kidelee/Projects/HQ-SciFi/node_modules/lucide-react/dist/esm/icons/${n}.mjs`)
  const d = mod.__iconData
  const attrs = (a) => Object.entries(a).filter(([k])=>k!=='key').map(([k,v])=>`${k}="${v}"`).join(' ')
  const body = d.node.map(([tag, a]) => `<${tag} ${attrs(a)}/>`).join('')
  out[n] = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#111827" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
}
console.log(JSON.stringify(out, null, 1))
