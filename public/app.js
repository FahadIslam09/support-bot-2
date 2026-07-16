document.addEventListener('DOMContentLoaded', () => {
    loadConfig();
    loadProducts();

    document.getElementById('configForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = {
            storeName: document.getElementById('storeName').value,
            aiEnabled: document.getElementById('aiEnabled').checked,
            systemPersona: document.getElementById('systemPersona').value,
            deliveryPolicy: document.getElementById('deliveryPolicy').value,
            paymentPolicy: document.getElementById('paymentPolicy').value
        };

        try {
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            if (res.ok) alert('Settings saved successfully!');
        } catch (err) {
            alert('Error saving settings.');
        }
    });

    document.getElementById('productForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const nameEl = document.getElementById('pName');
        const priceEl = document.getElementById('pPrice');
        const sizesEl = document.getElementById('pSizes');
        const featuresEl = document.getElementById('pFeatures');

        const data = {
            name: nameEl.value,
            price: priceEl.value,
            sizes: sizesEl.value,
            features: featuresEl.value
        };

        try {
            const res = await fetch('/api/products', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            if (res.ok) {
                nameEl.value = ''; priceEl.value = ''; sizesEl.value = ''; featuresEl.value = '';
                loadProducts();
            }
        } catch (err) {
            alert('Error adding product.');
        }
    });
});

async function loadConfig() {
    try {
        const res = await fetch('/api/config');
        const data = await res.json();
        
        document.getElementById('storeName').value = data.storeName || '';
        document.getElementById('aiEnabled').checked = data.aiEnabled;
        document.getElementById('systemPersona').value = data.systemPersona || '';
        document.getElementById('deliveryPolicy').value = data.deliveryPolicy || '';
        document.getElementById('paymentPolicy').value = data.paymentPolicy || '';
    } catch (err) {
        console.error('Error loading config', err);
    }
}

async function loadProducts() {
    try {
        const res = await fetch('/api/products');
        const products = await res.json();
        const list = document.getElementById('productList');
        
        if (products.length === 0) {
            list.innerHTML = '<p class="muted">No products found. Add one above.</p>';
            return;
        }

        list.innerHTML = products.map(p => `
            <div class="product-row">
                <div class="product-info">
                    <div class="product-name">${p.name}</div>
                    <div class="product-details">${p.price || 'N/A'} &middot; Sizes: ${p.sizes || 'N/A'}</div>
                </div>
                <button class="button-outline" onclick="deleteProduct('${p.id}')">Delete</button>
            </div>
        `).join('');
    } catch (err) {
        console.error('Error loading products', err);
    }
}

window.deleteProduct = async function(id) {
    if (!confirm('Are you sure you want to delete this product?')) return;
    try {
        await fetch(`/api/products/${id}`, { method: 'DELETE' });
        loadProducts();
    } catch (err) {
        alert('Error deleting product.');
    }
}
