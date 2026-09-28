GODWYN STORES — REDIRECT FIX

File: public/app.js

Replace this exact block:

  const orderProductId = new URLSearchParams(window.location.search).get('order');
  if (orderProductId) {
    const orderProduct = state.products.find(p => p.id === orderProductId);
    if (orderProduct && Number(orderProduct.qty) > 0) {
      state.orderDraft = { productId: orderProductId, qty: 1 };
      state.view = 'checkout';
      state.navOpen = false;
      state.cartOpen = false;
      state.reviewsOpenFor = null;
    }
    history.replaceState({}, document.title, window.location.pathname + window.location.hash);
  }

WITH this block:

  // Legacy ad links may use /?order=PRODUCT_ID. Never open checkout
  // automatically on page load. Land on the product details first.
  // Checkout is entered only after the shopper explicitly clicks Order Now.
  const orderProductId = new URLSearchParams(window.location.search).get('order');
  if (orderProductId) {
    const orderProduct = state.products.find(p => p.id === orderProductId);
    if (orderProduct) {
      state.selectedProductId = orderProductId;
      state.view = 'product';
      state.navOpen = false;
      state.cartOpen = false;
      state.reviewsOpenFor = null;
    }
    history.replaceState({}, document.title, window.location.pathname + window.location.hash);
  }

Effect:
- /?order=PRODUCT_ID now lands on the product detail page.
- The product page stays visible.
- Order Now still opens checkout when clicked.
- No other order/store functionality is changed.
