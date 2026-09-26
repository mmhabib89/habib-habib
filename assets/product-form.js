if (!customElements.get('product-form')) {
  customElements.define(
    'product-form',
    class ProductForm extends HTMLElement {
      constructor() {
        super();

        this.form = this.querySelector('form');
        this.variantIdInput.disabled = false;
        this.form.addEventListener('submit', this.onSubmitHandler.bind(this));
        this.cart = document.querySelector('cart-notification') || document.querySelector('cart-drawer');
        this.submitButton = this.querySelector('[type="submit"]');
        this.submitButtonText = this.submitButton.querySelector('span');
        this.autoGiftPicker = this.querySelector('[data-auto-gift-picker]');
        this.autoGiftVariantInput = this.querySelector('[data-auto-gift-variant]');

        if (document.querySelector('cart-drawer')) this.submitButton.setAttribute('aria-haspopup', 'dialog');

        this.hideErrors = this.dataset.hideErrors === 'true';
        this.updateAutoGiftPicker(this.getSelectedVariant());
        this.variantChangeUnsubscriber = subscribe(PUB_SUB_EVENTS.variantChange, ({ data }) => {
          if (String(data.sectionId) === this.dataset.sectionId) {
            this.updateAutoGiftPicker(data.variant);
          }
        });
      }

      disconnectedCallback() {
        this.variantChangeUnsubscriber?.();
      }

      updateAutoGiftPicker(variant) {
        if (!this.autoGiftPicker) return;

        const sizeOptionIndex = Number(this.dataset.sizeOptionIndex);
        const size = String(variant?.options?.[sizeOptionIndex] || '').trim().toLowerCase();
        const qualifies =
          (!variant?.id || Number(variant.id) === Number(this.form?.elements?.id?.value)) &&
          variant?.options?.some((value) => String(value).trim().toLowerCase() === 'black') &&
          (size === 'm' || size === 'medium');
        this.autoGiftPicker.hidden = !qualifies;
      }

      onSubmitHandler(evt) {
        evt.preventDefault();
        if (this.submitButton.getAttribute('aria-disabled') === 'true') return;

        this.handleErrorMessage();

        this.submitButton.setAttribute('aria-disabled', true);
        this.submitButton.classList.add('loading');
        this.querySelector('.loading__spinner').classList.remove('hidden');

        const config = fetchConfig('javascript');
        config.headers['X-Requested-With'] = 'XMLHttpRequest';
        delete config.headers['Content-Type'];

        const formData = new FormData(this.form);
        if (this.cart) {
          formData.append(
            'sections',
            this.cart.getSectionsToRender().map((section) => section.id)
          );
          formData.append('sections_url', window.location.pathname);
          this.cart.setActiveElement(document.activeElement);
        }
        config.body = formData;

        const variantId = formData.get('id');
        const quantity = parseInt(formData.get('quantity')) || 1;
        const selectedVariant = this.getSelectedVariant();
        const sizeOptionIndex = Number(this.dataset.sizeOptionIndex);
        const initialOptions = this.getInitialVariantOptions();
        const variantOptions = selectedVariant?.options || initialOptions;
        const sizeValue = variantOptions?.[sizeOptionIndex];
        const normalizedSize = String(sizeValue || '').trim().toLowerCase();
        const addsGift =
          (!selectedVariant?.id || Number(selectedVariant.id) === Number(variantId)) &&
          variantOptions?.some(
            (value) => String(value).trim().toLowerCase() === 'black'
          ) && (normalizedSize === 'm' || normalizedSize === 'medium');
        const autoGiftVariantId = Number(
          this.autoGiftVariantInput?.value || this.dataset.autoGiftVariantId || 0
        );
        const autoGiftProductId = Number(this.dataset.autoGiftProductId || 0);
        let qualifyingCartItem = null;

        if (addsGift && !autoGiftVariantId) {
          this.handleErrorMessage(this.dataset.autoGiftErrorMessage);
          this.submitButton.classList.remove('loading');
          this.submitButton.removeAttribute('aria-disabled');
          this.querySelector('.loading__spinner').classList.add('hidden');
          return;
        }

        if (addsGift) {
          qualifyingCartItem = { id: Number(variantId), quantity };
          const properties = {};
          for (const [key, value] of formData.entries()) {
            const propertyMatch = key.match(/^properties\[(.+)\]$/);
            if (propertyMatch) properties[propertyMatch[1]] = value;
            if (key === 'selling_plan') qualifyingCartItem.selling_plan = value;
          }
          if (Object.keys(properties).length) qualifyingCartItem.properties = properties;
        }

        const linesUpdateDeferred = this.createCartLinesUpdateEvent(variantId, quantity);

        const cartStatePromise = addsGift
          ? fetch(`${routes.cart_url}.js`, { headers: { Accept: 'application/json' } }).then((response) => {
              if (!response.ok) throw new Error(this.dataset.autoGiftErrorMessage);
              return response.json();
            })
          : Promise.resolve(null);

        cartStatePromise
          .then((cartData) => {
            if (addsGift) {
              const giftAlreadyInCart = (cartData?.items || []).some(
                (item) => Number(item.product_id) === autoGiftProductId
              );
              config.headers['Content-Type'] = 'application/json';
              config.body = JSON.stringify({
                items: [
                  qualifyingCartItem,
                  ...(!giftAlreadyInCart ? [{ id: autoGiftVariantId, quantity: 1 }] : []),
                ],
                sections: this.cart?.getSectionsToRender().map((section) => section.id) || [],
                sections_url: window.location.pathname,
              });
            }
            return fetch(`${routes.cart_add_url}`, config);
          })
          .then((response) => response.json())
          .then(async (response) => {
            if (response.status) {
              publish(PUB_SUB_EVENTS.cartError, {
                source: 'product-form',
                productVariantId: variantId,
                errors: response.errors || response.description,
                message: response.message,
              });
              this.handleErrorMessage(response.description);
              this.dispatchCartErrorEvent(response.description || response.message, 'INVALID');
              linesUpdateDeferred?.reject(new Error(response.description || response.message));

              const soldOutMessage = this.submitButton.querySelector('.sold-out-message');
              if (!soldOutMessage) return;
              this.submitButton.setAttribute('aria-disabled', true);
              this.submitButtonText.classList.add('hidden');
              soldOutMessage.classList.remove('hidden');
              this.error = true;
              return;
            }

            if (addsGift) {
              const cartResponse = await fetch(`${routes.cart_url}.js`, {
                headers: { Accept: 'application/json' },
              });
              if (!cartResponse.ok) {
                throw new Error(this.dataset.autoGiftErrorMessage);
              }
              const cartData = await cartResponse.json();
              const cartVariantIds = new Set(
                (cartData.items || []).map((item) => Number(item.variant_id))
              );
              const giftIsInCart = (cartData.items || []).some(
                (item) => Number(item.product_id) === autoGiftProductId
              );
              if (
                !cartVariantIds.has(Number(variantId)) ||
                !giftIsInCart
              ) {
                throw new Error(this.dataset.autoGiftErrorMessage);
              }
            }

            if (!this.cart) {
              this.resolveCartLinesUpdate(linesUpdateDeferred);
              window.location = window.routes.cart_url;
              return;
            }

            this.resolveCartLinesUpdate(linesUpdateDeferred);

            const startMarker = CartPerformance.createStartingMarker('add:wait-for-subscribers');
            if (!this.error)
              publish(PUB_SUB_EVENTS.cartUpdate, {
                source: 'product-form',
                productVariantId: variantId,
                cartData: response,
              }).then(() => {
                CartPerformance.measureFromMarker('add:wait-for-subscribers', startMarker);
              });
            this.error = false;
            const quickAddModal = this.closest('quick-add-modal');
            if (quickAddModal) {
              document.body.addEventListener(
                'modalClosed',
                () => {
                  setTimeout(() => {
                    CartPerformance.measure("add:paint-updated-sections", () => {
                      this.cart.renderContents(response);
                    });
                  });
                },
                { once: true }
              );
              quickAddModal.hide(true);
            } else {
              CartPerformance.measure("add:paint-updated-sections", () => {
                this.cart.renderContents(response);
              });
            }
          })
          .catch((e) => {
            console.error(e);
            this.handleErrorMessage(e.message || this.dataset.autoGiftErrorMessage);
            this.dispatchCartErrorEvent(e.message || 'Network error', 'SERVICE_UNAVAILABLE');
            linesUpdateDeferred?.reject(e);
          })
          .finally(() => {
            this.submitButton.classList.remove('loading');
            if (this.cart && this.cart.classList.contains('is-empty')) this.cart.classList.remove('is-empty');
            if (!this.error) this.submitButton.removeAttribute('aria-disabled');
            this.querySelector('.loading__spinner').classList.add('hidden');

            CartPerformance.measureFromEvent("add:user-action", evt);
          });
      }

      handleErrorMessage(errorMessage = false) {
        if (this.hideErrors) return;

        this.errorMessageWrapper =
          this.errorMessageWrapper || this.querySelector('.product-form__error-message-wrapper');
        if (!this.errorMessageWrapper) return;
        this.errorMessage = this.errorMessage || this.errorMessageWrapper.querySelector('.product-form__error-message');

        this.errorMessageWrapper.toggleAttribute('hidden', !errorMessage);

        if (errorMessage) {
          this.errorMessage.textContent = errorMessage;
        }
      }

      getSelectedVariant() {
        const productInfo = this.closest('product-info');
        const quickAddModal = this.closest('quick-add-modal');
        const selectedVariantScript =
          productInfo?.querySelector('variant-selects [data-selected-variant]') ||
          quickAddModal?.querySelector('variant-selects [data-selected-variant]');
        if (!selectedVariantScript) return null;

        try {
          return JSON.parse(selectedVariantScript.textContent);
        } catch (error) {
          console.error('Unable to read the selected product variant.', error);
          return null;
        }
      }

      getInitialVariantOptions() {
        if (!this.dataset.initialVariantOptions) return null;

        try {
          return JSON.parse(this.dataset.initialVariantOptions);
        } catch (error) {
          console.error('Unable to read the product card variant options.', error);
          return null;
        }
      }

      toggleSubmitButton(disable = true, text) {
        if (disable) {
          this.submitButton.setAttribute('disabled', 'disabled');
          if (text) this.submitButtonText.textContent = text;
        } else {
          this.submitButton.removeAttribute('disabled');
          this.submitButtonText.textContent = window.variantStrings.addToCart;
        }
      }

      createCartLinesUpdateEvent(variantId, quantity) {
        const { CartLinesUpdateEvent } = window.StandardEvents || {};
        if (!CartLinesUpdateEvent) return null;

        const deferred = CartLinesUpdateEvent.createPromise();
        this.dispatchEvent(
          new CartLinesUpdateEvent({
            action: 'add',
            context: 'product',
            lines: [{ merchandiseId: variantId, quantity }],
            promise: deferred.promise,
          })
        );
        return deferred;
      }

      resolveCartLinesUpdate(deferred) {
        if (!deferred) return;
        const { CartLinesUpdateEvent } = window.StandardEvents || {};
        if (!CartLinesUpdateEvent) return;

        const pendingCartDataPromise = typeof CartItems !== 'undefined'
          ? CartItems.fetchCartData()
          : fetch(`${routes.cart_url}.json`).then((response) => response.json());

        pendingCartDataPromise
          .then((cart) => {
            if (!cart?.currency) return deferred.reject(new Error('Missing currency in cart response'));
            deferred.resolve({ cart: CartLinesUpdateEvent.createCartFromAjaxResponse(cart) });
          })
          .catch((e) => deferred.reject(e));
      }

      dispatchCartErrorEvent(message, code) {
        const { CartErrorEvent } = window.StandardEvents || {};
        if (!CartErrorEvent) return;
        this.dispatchEvent(new CartErrorEvent({ error: message, code }));
      }

      get variantIdInput() {
        return this.form.querySelector('[name=id]');
      }
    }
  );
}
