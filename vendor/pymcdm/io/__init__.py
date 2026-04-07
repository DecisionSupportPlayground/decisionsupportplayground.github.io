# Stub io package — the real package uses pandas (not in Pyodide).
# We never call methods with verbose=True, so these are never exercised;
# they just need to exist so the method modules can import them at load time.

class TableDesc:
    def __init__(self, caption='', label='', symbol=None, rows=None, cols=None):
        self.caption = caption
        self.label   = label
        self.symbol  = symbol
        self.rows    = rows
        self.cols    = cols

class Table:
    pass

class MCDA_results:
    pass

class MCDA_problem:
    pass

__all__ = ['TableDesc', 'Table', 'MCDA_results', 'MCDA_problem']