const menu = document.querySelector('.menu');
const nav = document.querySelector('.site-header nav');
menu?.addEventListener('click', () => {
  const open = nav.classList.toggle('open');
  menu.setAttribute('aria-expanded', String(open));
});
nav?.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => nav.classList.remove('open')));

const copyButton = document.querySelector('.copy');
const command = document.querySelector('.code-block code')?.textContent;
copyButton?.addEventListener('click', async () => {
  await navigator.clipboard.writeText(command);
  copyButton.textContent = '已复制';
  setTimeout(() => copyButton.textContent = '复制', 1400);
});
