/**
 * Employee Controller
 * All methods use `req.db`, ensuring that queries are executed safely 
 * against the specific tenant's isolated database.
 */

exports.getAllEmployees = async (req, res) => {
  try {
    const [employees] = await req.db.query('SELECT * FROM employees ORDER BY created_at DESC');
    res.json({ success: true, data: employees });
  } catch (error) {
    console.error('Error fetching employees:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch employees' });
  }
};

exports.createEmployee = async (req, res) => {
  try {
    const { first_name, last_name, email, phone, role, salary, hire_date } = req.body;
    
    // Basic validation
    if (!first_name || !last_name) {
      return res.status(400).json({ success: false, error: 'First name and last name are required' });
    }

    const [result] = await req.db.query(
      `INSERT INTO employees (first_name, last_name, email, phone, role, salary, hire_date) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [first_name, last_name, email, phone, role, salary || 0, hire_date || null]
    );

    res.status(201).json({ 
      success: true, 
      message: 'Employee created successfully',
      data: { id: result.insertId } 
    });
  } catch (error) {
    console.error('Error creating employee:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, error: 'Email already exists' });
    }
    res.status(500).json({ success: false, error: 'Failed to create employee' });
  }
};

exports.updateEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const { first_name, last_name, email, phone, role, salary, status } = req.body;

    const [result] = await req.db.query(
      `UPDATE employees SET 
       first_name = COALESCE(?, first_name), 
       last_name = COALESCE(?, last_name),
       email = COALESCE(?, email),
       phone = COALESCE(?, phone),
       role = COALESCE(?, role),
       salary = COALESCE(?, salary),
       status = COALESCE(?, status)
       WHERE id = ?`,
      [first_name, last_name, email, phone, role, salary, status, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'Employee not found' });
    }

    res.json({ success: true, message: 'Employee updated successfully' });
  } catch (error) {
    console.error('Error updating employee:', error);
    res.status(500).json({ success: false, error: 'Failed to update employee' });
  }
};

exports.deleteEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    // We soft-delete by changing status, rather than a hard delete to preserve history
    const [result] = await req.db.query(
      'UPDATE employees SET status = "Terminated" WHERE id = ?',
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'Employee not found' });
    }

    res.json({ success: true, message: 'Employee terminated successfully' });
  } catch (error) {
    console.error('Error deleting employee:', error);
    res.status(500).json({ success: false, error: 'Failed to terminate employee' });
  }
};
