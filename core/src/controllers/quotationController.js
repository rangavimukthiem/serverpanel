/**
 * Quotation Controller
 * Demonstrates transactional inserts (creating a quote + its line items) 
 * across the dynamically injected req.db tenant database.
 */

exports.getAllQuotations = async (req, res) => {
  try {
    const [quotations] = await req.db.query('SELECT * FROM quotations ORDER BY created_at DESC');
    res.json({ success: true, data: quotations });
  } catch (error) {
    console.error('Error fetching quotations:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch quotations' });
  }
};

exports.getQuotationById = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Fetch the main quotation record
    const [quotes] = await req.db.query('SELECT * FROM quotations WHERE id = ?', [id]);
    if (quotes.length === 0) {
      return res.status(404).json({ success: false, error: 'Quotation not found' });
    }

    // Fetch the line items
    const [items] = await req.db.query('SELECT * FROM quotation_items WHERE quotation_id = ?', [id]);
    
    const quotation = quotes[0];
    quotation.items = items;

    res.json({ success: true, data: quotation });
  } catch (error) {
    console.error('Error fetching quotation details:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch quotation details' });
  }
};

exports.createQuotation = async (req, res) => {
  // We use a transaction because we need to insert the quote AND its line items safely
  let connection;
  try {
    const { client_name, client_email, client_phone, valid_until, notes, items } = req.body;
    
    if (!client_name || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'Client name and at least one item are required' });
    }

    // Calculate total amount from items
    const totalAmount = items.reduce((sum, item) => sum + (item.quantity * item.unit_price), 0);

    // Get a dedicated connection from the tenant pool for the transaction
    connection = await req.db.getConnection();
    await connection.beginTransaction();

    // 1. Insert Master Quotation
    const [quoteResult] = await connection.query(
      `INSERT INTO quotations (client_name, client_email, client_phone, total_amount, valid_until, notes) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [client_name, client_email, client_phone, totalAmount, valid_until || null, notes || '']
    );

    const quotationId = quoteResult.insertId;

    // 2. Insert Line Items
    for (const item of items) {
      const lineTotal = item.quantity * item.unit_price;
      await connection.query(
        `INSERT INTO quotation_items (quotation_id, description, quantity, unit_price, total_price)
         VALUES (?, ?, ?, ?, ?)`,
        [quotationId, item.description, item.quantity || 1, item.unit_price, lineTotal]
      );
    }

    await connection.commit();

    res.status(201).json({ 
      success: true, 
      message: 'Quotation created successfully',
      data: { id: quotationId, total_amount: totalAmount }
    });
  } catch (error) {
    console.error('Error creating quotation:', error);
    if (connection) await connection.rollback();
    res.status(500).json({ success: false, error: 'Failed to create quotation' });
  } finally {
    if (connection) connection.release();
  }
};

exports.updateQuotationStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['Draft', 'Sent', 'Accepted', 'Rejected'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid status' });
    }

    const [result] = await req.db.query(
      'UPDATE quotations SET status = ? WHERE id = ?',
      [status, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'Quotation not found' });
    }

    res.json({ success: true, message: `Quotation marked as ${status}` });
  } catch (error) {
    console.error('Error updating quotation status:', error);
    res.status(500).json({ success: false, error: 'Failed to update quotation status' });
  }
};
