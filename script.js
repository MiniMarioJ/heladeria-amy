// ============================================
// MENÚ MÓVIL (hamburguesa)
// ============================================
const navToggle = document.getElementById('navToggle');
const navLinks = document.getElementById('navLinks');

navToggle.addEventListener('click', () => {
  const isOpen = navLinks.classList.toggle('open');
  // aria-expanded le dice a lectores de pantalla si el menú está abierto
  navToggle.setAttribute('aria-expanded', isOpen);
});

// Cierra el menú automáticamente al pulsar un enlace (útil en móvil)
navLinks.querySelectorAll('a').forEach(link => {
  link.addEventListener('click', () => {
    navLinks.classList.remove('open');
    navToggle.setAttribute('aria-expanded', 'false');
  });
});

// ============================================
// FORMULARIO DE CONTACTO
// ============================================
const contactForm = document.getElementById('contactForm');
const formStatus = document.getElementById('formStatus');

contactForm.addEventListener('submit', (event) => {
  // Evita que el navegador recargue la página al enviar
  event.preventDefault();

  const nombre = document.getElementById('nombre').value.trim();
  const email = document.getElementById('email').value.trim();
  const mensaje = document.getElementById('mensaje').value.trim();

  // Validación sencilla en el cliente (el navegador ya valida "required",
  // esto es una comprobación extra antes de "enviar")
  if (!nombre || !email || !mensaje) {
    formStatus.textContent = 'Por favor, completa todos los campos.';
    formStatus.style.color = '#F2637A';
    return;
  }

  // NOTA IMPORTANTE:
  // Esto todavía no envía el mensaje a ningún sitio real. Para que el
  // formulario envíe un email de verdad necesitaremos un pequeño script
  // en el servidor (por ejemplo PHP, que XAMPP ya soporta). Lo veremos
  // como paso opcional más adelante si quieres.
  formStatus.textContent = `¡Gracias, ${nombre}! Hemos recibido tu mensaje.`;
  formStatus.style.color = '#8FBF7F';

  contactForm.reset();
});
