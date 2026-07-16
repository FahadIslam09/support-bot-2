document.addEventListener('DOMContentLoaded', () => {
    initNavigation();
    loadConfig();
    loadProducts();

    // Config Form
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
            if (res.ok) showToast('Settings saved successfully!');
        } catch (err) {
            showToast('Error saving settings', true);
        }
    });

    // Product Form
    document.getElementById('productForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('pId').value;
        const data = {
            name: document.getElementById('pName').value,
            price: document.getElementById('pPrice').value,
            sizes: document.getElementById('pSizes').value,
            features: document.getElementById('pFeatures').value
        };

        try {
            const method = id ? 'PUT' : 'POST';
            const url = id ? `/api/products/${id}` : '/api/products';
            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            if (res.ok) {
                resetProductForm();
                loadProducts();
                showToast(id ? 'Product updated' : 'Product added');
            }
        } catch (err) {
            showToast('Error saving product', true);
        }
    });

    document.getElementById('pCancelBtn').addEventListener('click', resetProductForm);
});

// Navigation
function initNavigation() {
    const links = document.querySelectorAll('.nav-link');
    const sections = document.querySelectorAll('.view-section');

    links.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            links.forEach(l => l.classList.remove('active'));
            sections.forEach(s => s.classList.remove('active'));
            
            link.classList.add('active');
            const target = link.getAttribute('data-target');
            document.getElementById(target).classList.add('active');

            if (target === 'messages') loadConversations();
        });
    });
}

// Config
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
        console.error(err);
    }
}

// Products
let allProducts = [];
async function loadProducts() {
    try {
        const res = await fetch('/api/products');
        allProducts = await res.json();
        const list = document.getElementById('productList');
        
        if (allProducts.length === 0) {
            list.innerHTML = '<p class="muted">No products found.</p>';
            return;
        }

        list.innerHTML = allProducts.map(p => `
            <div class="product-row">
                <div class="product-info">
                    <div class="product-name">${p.name} ${!p.isActive ? '(Inactive)' : ''}</div>
                    <div class="product-details">${p.price || 'N/A'} &middot; Sizes: ${p.sizes || 'N/A'}</div>
                </div>
                <div class="product-actions">
                    <button class="button-outline" onclick="editProduct('${p.id}')">Edit</button>
                    <button class="button-outline" onclick="toggleProduct('${p.id}', ${!p.isActive})">${p.isActive ? 'Disable' : 'Enable'}</button>
                    <button class="button-outline" onclick="deleteProduct('${p.id}')">Delete</button>
                </div>
            </div>
        `).join('');
    } catch (err) {
        console.error(err);
    }
}

function resetProductForm() {
    document.getElementById('pId').value = '';
    document.getElementById('pName').value = '';
    document.getElementById('pPrice').value = '';
    document.getElementById('pSizes').value = '';
    document.getElementById('pFeatures').value = '';
    document.getElementById('pSubmitBtn').textContent = 'Add Product';
    document.getElementById('pCancelBtn').style.display = 'none';
}

window.editProduct = function(id) {
    const p = allProducts.find(x => x.id === id);
    if (!p) return;
    document.getElementById('pId').value = p.id;
    document.getElementById('pName').value = p.name || '';
    document.getElementById('pPrice').value = p.price || '';
    document.getElementById('pSizes').value = p.sizes || '';
    document.getElementById('pFeatures').value = p.features || '';
    document.getElementById('pSubmitBtn').textContent = 'Update Product';
    document.getElementById('pCancelBtn').style.display = 'inline-block';
    
    document.querySelector('.nav-link[data-target="products"]').click();
}

window.toggleProduct = async function(id, isActive) {
    try {
        await fetch(`/api/products/${id}/toggle`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isActive })
        });
        loadProducts();
    } catch(err) {}
}

window.deleteProduct = async function(id) {
    if (!confirm('Are you sure you want to delete this product?')) return;
    try {
        await fetch(`/api/products/${id}`, { method: 'DELETE' });
        loadProducts();
    } catch (err) {
        showToast('Error deleting product', true);
    }
}

// Conversations
async function loadConversations() {
    try {
        const res = await fetch('/api/conversations');
        const convos = await res.json();
        const list = document.getElementById('conversationList');
        
        if (convos.length === 0) {
            list.innerHTML = '<p class="muted">No conversations yet.</p>';
            return;
        }

        list.innerHTML = convos.map(c => `
            <div class="convo-item" onclick="loadMessages('${c.id}', this)">
                <div class="convo-name">${c.firstName || 'Unknown'} ${c.lastName || ''}</div>
                <div class="convo-time">Last active: ${new Date(c.lastMessageAt).toLocaleString()}</div>
            </div>
        `).join('');
    } catch (err) {
        console.error(err);
    }
}

async function loadMessages(convId, el) {
    document.querySelectorAll('.convo-item').forEach(e => e.classList.remove('active'));
    if (el) el.classList.add('active');

    try {
        const res = await fetch(`/api/conversations/${convId}`);
        const msgs = await res.json();
        const history = document.getElementById('chatHistory');
        
        history.innerHTML = msgs.map(m => {
            const cls = m.role === 'user' ? 'msg-user' : (m.role === 'assistant' || m.role === 'model' ? 'msg-assistant' : 'msg-system');
            return `<div class="msg-bubble ${cls}">${m.content.replace(/\\n/g, '<br>')}</div>`;
        }).join('');
        history.scrollTop = history.scrollHeight;
    } catch(err) {
        console.error(err);
    }
}

// Toast
function showToast(message, isError = false) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = 'toast';
    if (isError) toast.style.backgroundColor = 'var(--semantic-error)';
    toast.textContent = message;
    
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.classList.add('hide');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}
