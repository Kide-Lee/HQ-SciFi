const specs = [
 ['sparkles',22,'#2563EB',2],
 ['calendar-days',22,'#9CA3AF',2],
 ['layers',22,'#9CA3AF',2],
 ['book-open',22,'#9CA3AF',2],
 ['pen-line',18,'#FFFFFF',2],
 ['search',20,'#4B5563',2],
 ['bell',20,'#4B5563',2],
 ['circle-dollar-sign',14,'#4F46E5',2],
 ['chevron-right',12,'#9CA3AF',2.4],
 ['star',11,'#DC2626',2],
 ['message-circle',10,'#9CA3AF',2.2],
 ['eye',10,'#9CA3AF',2.2],
 ['thumbs-up',10,'#9CA3AF',2.2]
]
for (const [n,size,color,sw] of specs) {
  const mod = await import(`/home/kidelee/Projects/HQ-SciFi/node_modules/lucide-react/dist/esm/icons/${n}.mjs`)
  const d = mod.__iconData
  const attrs = (a) => Object.entries(a).filter(([k])=>k!=='key').map(([k,v])=>`${k}="${v}"`).join(' ')
  const body = d.node.map(([tag, a]) => `<${tag} ${attrs(a)}/>`).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
  console.log(`### ${n}_${size}_${color.slice(1)}_${sw}\n${svg}\n`)
}
