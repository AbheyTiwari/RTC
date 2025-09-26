import uuid
from sqlalchemy import Column, String, DateTime, ForeignKey, TypeDecorator, CHAR
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from database import Base
import uuid

# Custom UUID type for SQLite compatibility
class GUID(TypeDecorator):
    """Platform-independent GUID type.
    Uses PostgreSQL's UUID type, otherwise uses
    CHAR(32), storing as stringified hex values.
    """
    impl = CHAR
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == 'postgresql':
            from sqlalchemy.dialects.postgresql import UUID
            return dialect.type_descriptor(UUID())
        else:
            return dialect.type_descriptor(CHAR(32))

    def process_bind_param(self, value, dialect):
        if value is None:
            return value
        elif dialect.name == 'postgresql':
            return str(value)
        else:
            if not isinstance(value, uuid.UUID):
                return "%.32x" % uuid.UUID(value).int
            else:
                # hexstring
                return "%.32x" % value.int

    def process_result_value(self, value, dialect):
        if value is None:
            return value
        else:
            if not isinstance(value, uuid.UUID):
                value = uuid.UUID(value)
            return value

class Meeting(Base):
    __tablename__ = "meetings"

    id = Column(GUID(), primary_key=True, default=uuid.uuid4)
    name = Column(String, index=True)
    created_at = Column(DateTime, server_default=func.now())
    
    participants = relationship("Participant", back_populates="meeting")


class Participant(Base):
    __tablename__ = "participants"

    id = Column(GUID(), primary_key=True, default=uuid.uuid4)
    username = Column(String, nullable=False)
    roll_number = Column(String, nullable=False, index=True)
    meeting_id = Column(GUID(), ForeignKey("meetings.id"), nullable=False)
    
    meeting = relationship("Meeting", back_populates="participants")
