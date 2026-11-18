// Asks "Are you sure?" before buttons marked data-confirm.
document.addEventListener("click", (event) => {
  const el = event.target instanceof Element ? event.target.closest("[data-confirm]") : null;
  if (el && !window.confirm(el.getAttribute("data-confirm"))) {
    event.preventDefault();
  }
});
