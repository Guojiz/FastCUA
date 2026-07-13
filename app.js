const menuButton = document.querySelector('.menu-button');
const navLinks = document.querySelector('.nav-links');
menuButton?.addEventListener('click', () => {
  navLinks.classList.toggle('open');
  menuButton.setAttribute('aria-expanded', String(navLinks.classList.contains('open')));
});
navLinks?.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => navLinks.classList.remove('open')));

const demos = [
  '打开画图，画一座房子、太阳和草地',
  '在文件资源管理器中整理下载目录',
  '跨浏览器与桌面应用完成一段工作流',
];
let demoIndex = 0;
const demoTask = document.querySelector('#demo-task');
if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  setInterval(() => {
    demoIndex = (demoIndex + 1) % demos.length;
    demoTask.textContent = demos[demoIndex];
  }, 3200);
}
