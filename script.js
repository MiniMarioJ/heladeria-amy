const menuButton = document.querySelector('.menu-toggle');
const navigation = document.querySelector('.main-nav');

menuButton.addEventListener('click', () => {
  const open = navigation.classList.toggle('open');
  menuButton.setAttribute('aria-expanded', open);
  menuButton.innerHTML = open ? 'Cerrar <span>×</span>' : 'Menú <span>+</span>';
});

document.querySelectorAll('.main-nav a').forEach((link) => link.addEventListener('click', () => {
  navigation.classList.remove('open');
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.innerHTML = 'Menú <span>+</span>';
}));

document.querySelector('#contact-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = new FormData(event.currentTarget).get('name');
  document.querySelector('.form-status').textContent = `¡Gracias, ${name}! Hemos recibido tu mensaje y te responderemos pronto.`;
  event.currentTarget.reset();
});

document.querySelector('#year').textContent = new Date().getFullYear();
