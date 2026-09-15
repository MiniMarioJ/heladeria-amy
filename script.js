const menuButton = document.querySelector('.menu');
const navigation = document.querySelector('header nav');

menuButton.addEventListener('click', () => {
  const open = navigation.classList.toggle('open');
  menuButton.setAttribute('aria-expanded', String(open));
  menuButton.innerHTML = open ? 'Cerrar <b>×</b>' : 'Menú <b>+</b>';
});

navigation.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => {
  navigation.classList.remove('open');
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.innerHTML = 'Menú <b>+</b>';
}));

document.querySelector('#year').textContent = new Date().getFullYear();
