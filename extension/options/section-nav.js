// Coati options page — the section menu (#sectionNav): plain anchors, so
// keyboard and history work natively; this module only marks the section
// being read (aria-current) while the page scrolls, and keeps that link in
// view when the menu is a horizontal row (narrow windows, options.css).

export function watchSections(nav) {
  const links = [...nav.querySelectorAll('a[href^="#"]')];
  const sections = links.map((link) => document.getElementById(link.hash.slice(1)));
  let current = -1;

  function update() {
    // The section whose top last passed a line a third down the window; the
    // last one once the page cannot scroll further.
    const line = window.innerHeight / 3;
    let index = 0;
    sections.forEach((section, i) => {
      if (section.getBoundingClientRect().top <= line) index = i;
    });
    const root = document.documentElement;
    if (window.scrollY > 0 && window.scrollY + window.innerHeight >= root.scrollHeight - 2) index = sections.length - 1;
    if (index === current) return;
    current = index;
    links.forEach((link, i) => link.setAttribute("aria-current", String(i === index)));
    if (nav.scrollWidth > nav.clientWidth) {
      const link = links[index];
      nav.scrollLeft = link.offsetLeft - (nav.clientWidth - link.offsetWidth) / 2;
    }
  }

  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
  update();
}
